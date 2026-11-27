import hashlib
import asyncio
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal
from threading import Barrier

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app import models, sarvam, shopping
from app.business import calculate_summary, create_sale, date_window, reserved_quantities
from app.db import Base, get_db
from app.main import app
from app.schemas import SaleCreate
from app.security import create_token
from app.shopping_schemas import StatusInput


@pytest.fixture
def client(db):
    shopping._rate_events.clear()
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        shopping._rate_events.clear()


def merchant(db, shop=None):
    shop = shop or db.info["shop"]
    user = models.User(shop_id=shop.id, email=f"{shop.id}@example.in", password_hash="unused-test-hash")
    db.add(user)
    db.commit()
    return {"Authorization": "Bearer " + create_token(user)}


def session(client, db, shop=None):
    shop = shop or db.info["shop"]
    base = f"/api/public/shops/{shop.id}"
    response = client.post(base + "/sessions", json={})
    assert response.status_code == 200, response.text
    return base, {"X-Shopping-Token": response.json()["session_token"]}, response.json()["cart"]


def filled(client, db, quantity=2):
    base, headers, cart = session(client, db)
    response = client.put(base + "/cart", headers=headers, json={
        "expected_revision": cart["revision"],
        "items": [{"product_id": db.info["product"].id, "quantity": quantity}],
    })
    assert response.status_code == 200, response.text
    return base, headers, response.json()


def submitted(client, db, quantity=2):
    base, headers, cart = filled(client, db, quantity)
    review = client.post(base + "/cart/review", headers=headers, json={"expected_revision": cart["revision"]})
    assert review.status_code == 200, review.text
    response = client.post(base + "/checkout", headers=headers,
                           json={"expected_revision": review.json()["revision"], "confirmed": True})
    assert response.status_code == 200, response.text
    return base, headers, response.json()


def test_public_catalogue_is_real_and_does_not_expose_business_records(client, db):
    private = models.Shop(name="Another shop")
    db.add(private)
    db.flush()
    db.add(models.Product(shop_id=private.id, name="Private product", stock=10, selling_price=1, purchase_price=0))
    db.commit()
    result = client.get(f"/api/public/shops/{db.info['shop'].id}")
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    data = result.json()
    assert len(data["products"]) == 1
    product = data["products"][0]
    assert set(product) == {"id", "name", "category", "unit", "price", "available"}
    assert product["id"] == db.info["product"].id
    assert Decimal(product["price"]) == 15 and Decimal(product["available"]) == 20
    assert all(value not in result.text for value in ["purchase_price", "password_hash", "Kumar Traders", "Ravi"])
    assert client.get("/api/products").status_code == 401
    assert client.get("/api/shopping/orders").status_code == 401


def test_capability_is_hashed_scoped_and_expires(client, db):
    base, headers, cart = session(client, db)
    second_base, second_headers, second_cart = session(client, db)
    row = db.scalar(select(models.ShoppingSession).where(
        models.ShoppingSession.token_hash == hashlib.sha256(headers["X-Shopping-Token"].encode()).hexdigest()))
    assert row and headers["X-Shopping-Token"] not in json.dumps(shopping.order_json(db, db.get(models.ShoppingOrder, cart["id"])))
    assert client.get(base + "/cart").status_code == 401
    assert client.get(base + f"/orders/{cart['id']}", headers=second_headers).status_code == 404
    other = models.Shop(name="Other")
    db.add(other)
    db.commit()
    assert client.get(f"/api/public/shops/{other.id}/cart", headers=headers).status_code == 401
    assert client.get("/api/shopping/orders/" + cart["id"], headers=merchant(db, other)).status_code == 404
    row.expires_at = models.now_utc() - timedelta(seconds=1)
    db.commit()
    assert client.get(base + "/cart", headers=headers).status_code == 401
    assert client.get(second_base + "/cart", headers=second_headers).json()["id"] == second_cart["id"]


def test_in_app_shop_search_is_bounded_literal_and_public_only(client, db):
    db.info["shop"].name = "Corner % Market"
    empty = models.Shop(name="Corner Empty")
    db.add(empty)
    for index in range(12):
        shop = models.Shop(name=f"Corner Shop {index:02}")
        db.add(shop)
        db.flush()
        db.add(models.Product(shop_id=shop.id, name="Milk", selling_price=30, stock=5))
    db.commit()
    response = client.get("/api/public/shops", params={"q": "corner"})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert len(response.json()) == 10
    assert all(set(row) == {"id", "name", "address"} for row in response.json())
    assert empty.id not in {row["id"] for row in response.json()}
    literal = client.get("/api/public/shops", params={"q": "% Market"}).json()
    assert len(literal) == 1 and literal[0]["id"] == db.info["shop"].id
    assert client.get("/api/public/shops", params={"q": "missing shop"}).json() == []
    for query in ["a", "  ", "x" * 101]:
        assert client.get("/api/public/shops", params={"q": query}).status_code == 422


@pytest.mark.parametrize("quantity", [0, -1, "NaN", "Infinity", 0.5, 1000, "0.0001"])
def test_cart_rejects_bad_or_fractional_packet_quantities(client, db, quantity):
    base, headers, cart = session(client, db)
    response = client.put(base + "/cart", headers=headers, json={
        "expected_revision": 0, "items": [{"product_id": db.info["product"].id, "quantity": quantity}],
    })
    assert response.status_code == 422, response.text
    assert client.get(base + "/cart", headers=headers).json()["items"] == []


def test_cart_uses_server_prices_and_validates_actual_stock(client, db):
    base, headers, cart = session(client, db)
    item = {"product_id": db.info["product"].id, "quantity": 2}
    for items, status in [([{**item, "unit_price": 1}], 422), ([item, item], 422),
                          ([{**item, "quantity": 21}], 409),
                          ([{**item, "product_id": str(uuid.uuid4())}], 404)]:
        response = client.put(base + "/cart", headers=headers, json={"expected_revision": 0, "items": items})
        assert response.status_code == status, response.text
    db.info["product"].unit = "kg"
    db.commit()
    response = client.put(base + "/cart", headers=headers, json={
        "expected_revision": 0, "items": [{**item, "quantity": "0.125"}],
    })
    assert response.status_code == 200, response.text
    assert Decimal(response.json()["total"]) == Decimal("1.88")
    assert Decimal(response.json()["items"][0]["unit_price"]) == 15
    assert client.put(base + "/cart", headers=headers, json={"expected_revision": 0, "items": []}).status_code == 409


def test_checkout_needs_review_and_explicit_confirmation_and_is_idempotent(client, db):
    base, headers, cart = filled(client, db)
    request = {"expected_revision": cart["revision"], "confirmed": True}
    assert client.post(base + "/checkout", headers=headers, json=request).status_code == 409
    review = client.post(base + "/cart/review", headers=headers, json={"expected_revision": cart["revision"]}).json()
    for invalid in [{"expected_revision": review["revision"]},
                    {"expected_revision": review["revision"], "confirmed": False},
                    {"expected_revision": review["revision"], "confirmed": 1},
                    {"expected_revision": review["revision"], "confirmed": "true"}]:
        assert client.post(base + "/checkout", headers=headers, json=invalid).status_code == 422
    for _ in range(2):
        response = client.post(base + "/checkout", headers=headers, json=request)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "pending_shopkeeper_confirmation"
        assert response.json()["id"] == cart["id"]
    assert db.scalar(select(func.count()).select_from(models.ShoppingOrder)) == 1
    assert db.info["product"].stock == 20
    assert not db.scalars(select(models.Sale)).all()
    assert client.put(base + "/cart", headers=headers, json={
        "expected_revision": response.json()["revision"], "items": [],
    }).status_code == 409


def test_price_change_requires_fresh_review_and_never_silently_submits(client, db):
    base, headers, cart = filled(client, db)
    client.post(base + "/cart/review", headers=headers, json={"expected_revision": cart["revision"]})
    db.info["product"].selling_price = Decimal("17")
    db.commit()
    response = client.post(base + "/checkout", headers=headers,
                           json={"expected_revision": cart["revision"], "confirmed": True})
    assert response.status_code == 409
    current = client.get(base + "/cart", headers=headers).json()
    assert current["status"] == "draft" and not current["checkout_confirmation_pending"]
    reviewed = client.post(base + "/cart/review", headers=headers, json={"expected_revision": current["revision"]}).json()
    assert Decimal(reviewed["total"]) == 34
    db.info["product"].stock = Decimal("1")
    db.commit()
    assert client.post(base + "/checkout", headers=headers, json={
        "expected_revision": reviewed["revision"], "confirmed": True,
    }).status_code == 409
    assert db.get(models.ShoppingOrder, cart["id"]).status == "draft"


def test_order_completion_cannot_link_a_different_sale_request_key(client, db):
    auth = merchant(db)
    base, headers, cart = submitted(client, db)
    path = "/api/shopping/orders/" + cart["id"] + "/status"
    for status in ["accepted", "ready_for_collection"]:
        cart = client.post(path, headers=auth, json={"expected_revision": cart["revision"], "status": status}).json()
    create_sale(db, db.info["shop"], SaleCreate(
        items=[{"product_id": db.info["product"].id, "quantity": 1}],
        payment_method="cash", idempotency_key="shopping-order:" + cart["id"],
    ))
    response = client.post(path, headers=auth, json={
        "expected_revision": cart["revision"], "status": "completed", "payment_method": "cash",
    })
    assert response.status_code == 409
    order = client.get(base + "/cart", headers=headers).json()
    assert order["status"] == "ready_for_collection" and order["sale_id"] is None
    assert len(db.scalars(select(models.Sale)).all()) == 1


def test_negative_stock_opt_in_does_not_spend_customer_reservations(client, db):
    auth = merchant(db)
    base, headers, cart = submitted(client, db, 3)
    cart = client.post("/api/shopping/orders/" + cart["id"] + "/status", headers=auth,
                       json={"expected_revision": cart["revision"], "status": "accepted"}).json()
    db.info["shop"].allow_negative_stock = True
    db.commit()
    payload = SaleCreate(items=[{"product_id": db.info["product"].id, "quantity": 25}],
                         payment_method="cash", idempotency_key="negative-stock-retail-sale")
    with pytest.raises(HTTPException) as error:
        create_sale(db, db.info["shop"], payload)
    assert error.value.status_code == 409
    db.rollback()
    client.post(base + "/orders/" + cart["id"] + "/cancel", headers=headers,
                json={"expected_revision": cart["revision"]}).raise_for_status()
    sale, _ = create_sale(db, db.info["shop"], payload)
    assert sale.total == 375 and db.info["product"].stock == -5


@pytest.mark.parametrize("payment_method", ["cash", "upi"])
def test_accept_reserves_and_completion_records_exactly_one_existing_sale(client, db, payment_method):
    auth = merchant(db)
    base, headers, cart = submitted(client, db, 3)
    path = "/api/shopping/orders/" + cart["id"] + "/status"
    assert client.post(path, headers=auth, json={
        "expected_revision": cart["revision"], "status": "completed", "payment_method": payment_method,
    }).status_code == 409
    accepted = client.post(path, headers=auth, json={"expected_revision": cart["revision"], "status": "accepted"}).json()
    assert accepted["status"] == "accepted"
    assert db.info["product"].stock == 20
    assert reserved_quantities(db, db.info["shop"].id)[db.info["product"].id] == 3
    assert Decimal(client.get(base).json()["products"][0]["available"]) == 17
    assert client.patch("/api/products/" + db.info["product"].id, headers=auth, json={"stock": 2}).status_code == 409
    assert client.delete("/api/products/" + db.info["product"].id, headers=auth).status_code == 409
    with pytest.raises(HTTPException):
        create_sale(db, db.info["shop"], SaleCreate(
            items=[{"product_id": db.info["product"].id, "quantity": 18}],
            payment_method="cash", idempotency_key="reserved-retail-sale"))
    db.rollback()
    ready = client.post(path, headers=auth, json={
        "expected_revision": accepted["revision"], "status": "ready_for_collection",
    }).json()
    assert client.post(path, headers=auth, json={
        "expected_revision": ready["revision"], "status": "completed",
    }).status_code == 422
    final_request = {"expected_revision": ready["revision"], "status": "completed", "payment_method": payment_method}
    first = client.post(path, headers=auth, json=final_request)
    assert first.status_code == 200, first.text
    duplicate = client.post(path, headers=auth, json=final_request)
    assert duplicate.status_code == 200 and duplicate.json()["sale_id"] == first.json()["sale_id"]
    db.refresh(db.info["product"])
    assert db.info["product"].stock == 17
    sales = db.scalars(select(models.Sale)).all()
    assert len(sales) == 1 and sales[0].total == 45 and sales[0].payment_method == payment_method
    assert len(db.scalars(select(models.SaleItem)).all()) == 1
    assert len(db.scalars(select(models.InventoryMovement)).all()) == 1
    assert reserved_quantities(db, db.info["shop"].id) == {}
    summary = calculate_summary(db, db.info["shop"].id, *date_window(1))
    assert summary["sales"] == 45 and summary["sale_count"] == 1
    customer = client.get(base + "/orders/" + cart["id"], headers=headers).json()
    assert [event["status"] for event in customer["events"]] == [
        "pending_shopkeeper_confirmation", "accepted", "ready_for_collection", "completed",
    ]


@pytest.mark.parametrize("action", ["customer_cancel", "merchant_reject", "merchant_cancel"])
def test_cancellation_and_rejection_release_stock_without_sales(client, db, action):
    auth = merchant(db)
    base, headers, cart = submitted(client, db, 5)
    path = "/api/shopping/orders/" + cart["id"] + "/status"
    if action != "merchant_reject":
        cart = client.post(path, headers=auth, json={"expected_revision": cart["revision"], "status": "accepted"}).json()
    if action == "customer_cancel":
        response = client.post(base + "/orders/" + cart["id"] + "/cancel", headers=headers,
                               json={"expected_revision": cart["revision"]})
    else:
        response = client.post(path, headers=auth, json={
            "expected_revision": cart["revision"],
            "status": "rejected" if action == "merchant_reject" else "cancelled",
            "note": "Sorry, unavailable today.",
        })
    assert response.status_code == 200, response.text
    assert reserved_quantities(db, db.info["shop"].id) == {}
    assert db.info["product"].stock == 20
    assert not db.scalars(select(models.Sale)).all()


def test_text_enquiries_messages_and_status_are_accessible_to_only_both_parties(client, db):
    auth = merchant(db)
    base, headers, cart = session(client, db)
    path = base + "/orders/" + cart["id"] + "/messages"
    assert client.get("/api/shopping/orders", headers=auth).json() == []
    sent = client.post(path, headers=headers, json={"text": "Please write your reply.", "language": "en-IN"})
    assert sent.status_code == 200 and sent.json()["sender"] == "customer"
    assert client.get("/api/shopping/orders", headers=auth).json()[0]["id"] == cart["id"]
    reply = client.post("/api/shopping/orders/" + cart["id"] + "/messages", headers=auth,
                        json={"text": "Of course. How can I help?", "language": "en-IN"})
    assert reply.status_code == 200
    messages = client.get(path, headers=headers).json()
    assert [message["sender"] for message in messages] == ["customer", "shopkeeper"]
    assert client.post(path, headers=headers, json={"text": " ", "language": "en-IN"}).status_code == 422
    _, _, newer = submitted(client, db)
    assert client.get("/api/shopping/orders", headers=auth).json()[0]["id"] == newer["id"]
    client.post(path, headers=headers, json={"text": "I still need help with this request.", "language": "en-IN"})
    assert client.get("/api/shopping/orders", headers=auth).json()[0]["id"] == cart["id"]


@pytest.mark.parametrize("accept", [False, True])
def test_substitution_requires_explicit_customer_consent_and_real_price(client, db, accept):
    auth = merchant(db)
    base, headers, cart = submitted(client, db)
    replacement = models.Product(shop_id=db.info["shop"].id, name="Other noodles", unit="pack",
                                 stock=10, purchase_price=10, selling_price=18)
    db.add(replacement)
    db.commit()
    path = "/api/shopping/orders/" + cart["id"]
    proposed = client.post(path + "/substitutions", headers=auth, json={
        "expected_revision": cart["revision"], "product_id": db.info["product"].id,
        "replacement_product_id": replacement.id, "quantity": 2, "note": "Is this brand okay?",
    })
    assert proposed.status_code == 200, proposed.text
    offered = proposed.json()
    assert Decimal(offered["total"]) == 30 and Decimal(offered["proposal"]["total"]) == 36
    assert offered["items"][0]["product_id"] == db.info["product"].id
    assert client.post(path + "/status", headers=auth, json={
        "expected_revision": offered["revision"], "status": "accepted",
    }).status_code == 409
    response = client.post(base + "/orders/" + cart["id"] + "/substitution", headers=headers,
                           json={"expected_revision": offered["revision"], "accept": accept})
    assert response.status_code == 200, response.text
    chosen = response.json()
    assert chosen["proposal"] is None
    assert chosen["items"][0]["product_id"] == (replacement.id if accept else db.info["product"].id)
    assert Decimal(chosen["total"]) == (36 if accept else 30)


def test_stale_replacement_price_cannot_be_approved(client, db):
    auth = merchant(db)
    base, headers, cart = submitted(client, db)
    replacement = models.Product(shop_id=db.info["shop"].id, name="Alternate", stock=10, selling_price=18, purchase_price=10)
    db.add(replacement)
    db.commit()
    proposed = client.post("/api/shopping/orders/" + cart["id"] + "/substitutions", headers=auth, json={
        "expected_revision": cart["revision"], "product_id": db.info["product"].id,
        "replacement_product_id": replacement.id, "quantity": 1,
    }).json()
    replacement.selling_price = 20
    db.commit()
    response = client.post(base + "/orders/" + cart["id"] + "/substitution", headers=headers, json={
        "expected_revision": proposed["revision"], "accept": True,
    })
    assert response.status_code == 409
    assert db.get(models.ShoppingOrder, cart["id"]).total == 30


def mock_tools(monkeypatch, batches):
    async def complete(messages, tools):
        assert all(tool["function"]["name"] not in {"create_sale", "checkout", "create_supplier"} for tool in tools)
        calls = batches.pop(0)
        if isinstance(calls, str):
            return {"role": "assistant", "content": calls}
        return {"role": "assistant", "content": None, "tool_calls": [
            {"id": str(uuid.uuid4()), "type": "function",
             "function": {"name": name, "arguments": json.dumps(arguments)}} for name, arguments in calls
        ]}
    monkeypatch.setattr(sarvam, "complete_with_tools", complete)


def assistant(client, base, headers, message, request_id=None):
    return client.post(base + "/assistant", headers=headers, json={
        "message": message, "language": "en-IN", "request_id": request_id or str(uuid.uuid4()),
    })


def test_voice_shopping_tools_review_then_explicit_yes_and_deduplicate(client, db, monkeypatch):
    base, headers, cart = session(client, db)
    mock_tools(monkeypatch, [[("search_products", {"query": "Maggi"})],
                            [("set_cart_item", {"product_id": db.info["product"].id, "quantity": 2}),
                             ("prepare_checkout", {})]])
    request_id = str(uuid.uuid4())
    reviewed = assistant(client, base, headers, "I need two packs of Maggi", request_id)
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["confirmation_required"]
    assert reviewed.json()["cart"]["status"] == "draft"
    assert Decimal(reviewed.json()["cart"]["total"]) == 30
    duplicate = assistant(client, base, headers, "I need two packs of Maggi", request_id)
    assert duplicate.status_code == 200 and duplicate.json()["cart"]["items"][0]["quantity"] == "2.000"
    confirmed = assistant(client, base, headers, "Yes")
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["cart"]["status"] == "pending_shopkeeper_confirmation"
    assert assistant(client, base, headers, "Yes").json()["cart"]["id"] == cart["id"]
    assert db.scalar(select(func.count()).select_from(models.ShoppingOrder)) == 1
    assert db.scalar(select(func.count()).select_from(models.Sale)) == 0


def test_unrelated_question_clears_old_voice_confirmation(client, db, monkeypatch):
    base, headers, cart = filled(client, db)
    client.post(base + "/cart/review", headers=headers, json={"expected_revision": cart["revision"]})
    mock_tools(monkeypatch, ["The shop will confirm collection time.", "Please review your cart before placing an order."])
    assert assistant(client, base, headers, "What time can I collect?").status_code == 200
    answer = assistant(client, base, headers, "Yes")
    assert answer.status_code == 200, answer.text
    assert answer.json()["cart"]["status"] == "draft"
    assert not answer.json()["confirmation_required"]


@pytest.mark.parametrize("language,message,confirmed", [
    ("hi-IN", "\u0939\u093e\u0901\u0964", True),
    ("hi-IN", "\u0928\u0939\u0940\u0902\u0964", False),
    ("ta-IN", "\u0b86\u0bae\u0bbe\u0bae\u0bcd!", True),
])
def test_speech_confirmation_handles_indic_sentence_punctuation(client, db, monkeypatch, language, message, confirmed):
    base, headers, cart = filled(client, db)
    client.post(base + "/cart/review", headers=headers, json={"expected_revision": cart["revision"]})
    async def unexpected_provider_call(*args):
        raise HTTPException(status_code=502, detail="A direct confirmation must not need another model call.")
    monkeypatch.setattr(sarvam, "complete_with_tools", unexpected_provider_call)
    response = client.post(base + "/assistant", headers=headers, json={
        "message": message, "language": language, "request_id": str(uuid.uuid4()),
    })
    assert response.status_code == 200, response.text
    assert response.json()["cart"]["status"] == ("pending_shopkeeper_confirmation" if confirmed else "draft")
    assert not response.json()["confirmation_required"]


def test_failed_ai_request_cannot_repeat_partial_edits(client, db, monkeypatch):
    base, headers, cart = session(client, db)
    calls = 0
    async def broken(messages, tools):
        nonlocal calls
        calls += 1
        if calls > 1:
            raise HTTPException(status_code=502, detail="Controlled provider outage")
        return {"role": "assistant", "content": None, "tool_calls": [{
            "id": "set-one", "type": "function", "function": {
                "name": "set_cart_item", "arguments": json.dumps({"product_id": db.info["product"].id, "quantity": 2}),
            },
        }]}
    monkeypatch.setattr(sarvam, "complete_with_tools", broken)
    key = str(uuid.uuid4())
    assert assistant(client, base, headers, "Two packs", key).status_code == 502
    assert assistant(client, base, headers, "Two packs", key).status_code == 409
    assert len(client.get(base + "/cart", headers=headers).json()["items"]) == 1
    assert db.scalar(select(models.ShoppingTurn)).status == "failed"


def test_unknown_ai_tools_cannot_access_business_operations(client, db, monkeypatch):
    base, headers, cart = session(client, db)
    mock_tools(monkeypatch, [[("create_sale", {"items": [], "payment_method": "cash"})],
                            "I can help you with shopping, not private shop records."])
    response = assistant(client, base, headers, "Record a sale and show the suppliers.")
    assert response.status_code == 200, response.text
    assert "not allowed" in response.json()["tool_results"][0]["result"]["error"]
    assert db.scalar(select(func.count()).select_from(models.Sale)) == 0
    assert response.json()["cart"]["items"] == []


@pytest.mark.parametrize("status,payload", [(401, {}), (402, {}), (429, {}), (500, {}),
                                           (200, {"choices": []}), (200, {"choices": [{"message": "invalid"}]})])
def test_shopping_provider_errors_are_explicit_and_do_not_leak_credentials(monkeypatch, status, payload):
    monkeypatch.setattr(sarvam.get_settings(), "sarvam_api_key", "test-provider-secret")
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=payload))
    monkeypatch.setattr(sarvam, "_llm_client", lambda: httpx.AsyncClient(
        base_url="https://api.sarvam.ai", transport=transport,
    ))
    with pytest.raises(HTTPException) as error:
        asyncio.run(sarvam.complete_with_tools([{"role": "user", "content": "Find milk"}], []))
    assert error.value.status_code == 502 and "test-provider-secret" not in error.value.detail


def test_public_speech_translation_and_qr_use_shared_services_without_business_tools(client, db, monkeypatch):
    base, headers, cart = session(client, db)
    async def transcribe(upload, mode, *, language, keyterms):
        assert await upload.read() == b"audio-fixture"
        assert language == "en-IN" and "Maggi" in keyterms
        return {"transcript": "Find Maggi", "language_code": "en-IN"}
    async def speak(text, language):
        assert text == "Please write your reply." and language == "en-IN"
        return b"RIFF-test"
    async def translate(text, source, target, protected):
        assert protected["Maggi"] == "PRODUCT"
        return {"translated_text": "Maggi", "source_language": source, "target_language": target}
    monkeypatch.setattr(sarvam, "transcribe", transcribe)
    monkeypatch.setattr(sarvam, "speak", speak)
    monkeypatch.setattr(sarvam, "translate_text", translate)
    assert client.post(base + "/voice/transcribe", headers=headers, files={"file": ("voice.webm", b"audio-fixture")},
                       data={"language": "en-IN", "mode": "transcribe"}).json()["transcript"] == "Find Maggi"
    speech = client.post(base + "/voice/speak", headers=headers, json={"text": "Please write your reply.", "language": "en-IN"})
    assert speech.status_code == 200 and speech.content == b"RIFF-test"
    assert client.post(base + "/translate", headers=headers, json={
        "text": "Maggi", "source_language": "en-IN", "target_language": "ta-IN",
    }).json()["translated_text"] == "Maggi"
    qr = client.get(base + "/qr.svg")
    assert qr.status_code == 200 and "<svg" in qr.text
    auth = merchant(db)
    link = client.get("/api/shopping/link", headers=auth).json()
    assert link["url"].endswith("/shop/" + db.info["shop"].id)
    assert headers["X-Shopping-Token"] not in link["url"] and link["local_only"]


@pytest.mark.parametrize("other_action", ["accept", "retail_sale"])
def test_concurrent_acceptance_and_retail_sale_cannot_oversell(tmp_path, other_action):
    engine = create_engine("sqlite:///" + str(tmp_path / "concurrent.db"), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as db:
        shop = models.Shop(name="Concurrent QA")
        db.add(shop)
        db.flush()
        product = models.Product(shop_id=shop.id, name="Milk", unit="packet", stock=3, selling_price=30, purchase_price=20)
        db.add(product)
        db.flush()
        orders = []
        for index in range(2):
            customer = models.ShoppingSession(shop_id=shop.id, token_hash=str(index) * 64,
                                              expires_at=models.now_utc() + timedelta(days=1))
            db.add(customer)
            db.flush()
            order = models.ShoppingOrder(shop_id=shop.id, session_id=customer.id, status="pending_shopkeeper_confirmation", total=60)
            db.add(order)
            db.flush()
            db.add(models.ShoppingOrderItem(order_id=order.id, product_id=product.id, name="Milk",
                                            unit="packet", quantity=2, unit_price=30))
            orders.append(order.id)
        db.commit()
        shop_id, product_id = shop.id, product.id
    barrier = Barrier(2)
    def accept(order_id):
        with factory() as db:
            order = db.get(models.ShoppingOrder, order_id)
            barrier.wait(timeout=5)
            try:
                if other_action == "retail_sale" and order_id == orders[1]:
                    create_sale(db, db.get(models.Shop, shop_id), SaleCreate(
                        items=[{"product_id": product_id, "quantity": 2}],
                        payment_method="cash", idempotency_key="concurrent-retail-sale",
                    ))
                else:
                    shopping.change_status(db, order, StatusInput(expected_revision=0, status="accepted"))
                return 200
            except HTTPException as exc:
                db.rollback()
                return exc.status_code
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(accept, orders)) == [200, 409]
    with factory() as db:
        reserved = reserved_quantities(db, shop_id).get(product_id, Decimal("0"))
        stock = db.get(models.Product, product_id).stock
        assert stock - reserved == 1
        assert (stock, reserved) in {(Decimal("3"), Decimal("2")), (Decimal("1"), Decimal("0"))}
    engine.dispose()
