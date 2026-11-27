import asyncio
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import models, sarvam
from app.business import create_pending, execute_pending
from app.db import get_db
from app.main import app
from app.schemas import normalize_phone
from test_translation import mock_translation


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def register_mobile(client, number="9876543210"):
    response = client.post("/api/auth/register", json={
        "phone": number, "password": "private-password", "shop_name": "Voice shop",
    })
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


def test_mobile_signup_login_and_language_survive_new_session(client, db):
    headers = register_mobile(client)
    initial = client.get("/api/shop", headers=headers).json()
    assert initial["language_configured"] is False
    saved = client.patch("/api/shop", headers=headers, json={"language": "ta-IN"})
    assert saved.status_code == 200
    assert saved.json()["language_configured"] is True
    login = client.post("/api/auth/login", json={"identifier": "+91 98765 43210", "password": "private-password"})
    assert login.status_code == 200
    loaded = client.get("/api/shop", headers={"Authorization": "Bearer " + login.json()["access_token"]}).json()
    assert loaded["language"] == "ta-IN" and loaded["language_configured"] is True
    assert db.scalar(select(models.User).where(models.User.phone == "+919876543210")).email is None
    duplicate = client.post("/api/auth/register", json={
        "phone": "+91-98765-43210", "password": "another-password", "shop_name": "Duplicate",
    })
    assert duplicate.status_code == 409
    assert client.post("/api/auth/login", json={"identifier": "9876543210", "password": "wrong"}).status_code == 401


def test_email_login_stays_compatible_and_shop_preferences_are_isolated(client):
    client.post("/api/auth/register", json={"email": "One@Example.in", "password": "private-password", "shop_name": "Email shop"})
    login = client.post("/api/auth/login", json={"email": "one@example.in", "password": "private-password"})
    assert login.status_code == 200
    first = {"Authorization": "Bearer " + login.json()["access_token"]}
    second = register_mobile(client)
    assert client.patch("/api/shop", headers=first, json={"language": "en-IN"}).status_code == 200
    assert client.get("/api/shop", headers=second).json()["language_configured"] is False
    assert client.patch("/api/shop", headers=first, json={"language": "xx-XX"}).status_code == 422


@pytest.mark.parametrize("number", ["12345", "1234567890", "9876543210 OR 1=1", "+449876543210"])
def test_bad_mobile_identifiers_are_rejected(number):
    with pytest.raises(ValueError):
        normalize_phone(number)


def test_language_detector_calls_real_provider_contract(monkeypatch):
    def handler(request):
        assert request.url.path == "/text-lid"
        assert json.loads(request.content) == {"input": "வணக்கம்"}
        return httpx.Response(200, json={"language_code": "ta-IN"})
    mock_translation(monkeypatch, handler)
    assert asyncio.run(sarvam.identify_language("வணக்கம்")) == "ta-IN"


@pytest.mark.parametrize("response", [{"language_code": "xx-XX"}, {}, {"language_code": None}])
def test_unknown_language_has_no_silent_fallback(monkeypatch, response):
    mock_translation(monkeypatch, lambda _: httpx.Response(200, json=response))
    with pytest.raises(HTTPException) as error:
        asyncio.run(sarvam.identify_language("Unknown"))
    assert error.value.status_code == 422


def test_automatic_translation_same_language_and_low_confidence_are_safe(monkeypatch, client, db):
    headers = register_mobile(client)
    action = create_pending(db, db.info["shop"].id, "record_customer_payment",
                            {"customer_id": db.info["customer"].id, "amount": "20"}, summary="Pending payment")
    seen = []

    async def identify(text):
        seen.append(text)
        return "en-IN"

    def forbidden(*args, **kwargs):
        pytest.fail("Same-language speech or unclear audio must not call translation or business tools.")

    monkeypatch.setattr("app.main.identify_language", identify)
    monkeypatch.setattr("app.main.translate_text", forbidden)
    monkeypatch.setattr(sarvam, "execute_tool", forbidden)
    payload = {"text": "Record a payment of 20", "source_language": "auto", "target_language": "en-IN"}
    response = client.post("/api/translation", headers=headers, json=payload)
    assert response.status_code == 200 and response.json()["same_language"] is True
    assert response.json()["translated_text"] == payload["text"]
    assert seen == [payload["text"]]
    unclear = client.post("/api/translation", headers=headers, json={
        **payload, "detected_language": "hi-IN", "language_probability": 0.3,
    })
    assert unclear.status_code == 422
    db.refresh(action)
    assert action.status == "pending"
    assert db.scalar(select(func.count()).select_from(models.Sale)) == 0


def test_automatic_translation_uses_detected_audio_language_without_extra_detector(monkeypatch, client):
    headers = register_mobile(client)

    async def translate(text, source, target, terms):
        assert source == "ta-IN" and target == "hi-IN"
        return {"original_text": text, "translated_text": "नमस्ते", "source_language": source, "target_language": target}

    def forbidden(*args):
        pytest.fail("Audio already supplied a supported language; no text detection request is needed.")

    monkeypatch.setattr("app.main.identify_language", forbidden)
    monkeypatch.setattr("app.main.translate_text", translate)
    result = client.post("/api/translation", headers=headers, json={
        "text": "வணக்கம்", "source_language": "auto", "target_language": "hi-IN",
        "detected_language": "ta-IN", "language_probability": 0.94,
    })
    assert result.status_code == 200
    assert result.json()["source_language"] == "ta-IN"


def test_navigation_is_whitelisted_and_never_mutates_business_data(db):
    result = sarvam.execute_tool(db, db.info["shop"], "navigate_app", {"page": "Translator"})
    assert result == {"destination": "Translator", "mode": "translation"}
    with pytest.raises(ValueError):
        sarvam.execute_tool(db, db.info["shop"], "navigate_app", {"page": "https://evil.example"})
    assert db.scalar(select(func.count()).select_from(models.PendingAction)) == 0
    assert db.info["product"].stock == 20


def test_native_tool_can_open_translator_without_recording_transactions(monkeypatch, db):
    responses = [
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "navigate-one", "type": "function",
            "function": {"name": "navigate_app", "arguments": '{"page":"Translator"}'},
        }]},
        {"role": "assistant", "content": "Ready. Ask the customer to speak first."},
    ]

    def handler(request):
        return httpx.Response(200, json={"choices": [{"message": responses.pop(0)}]})

    mock_translation(monkeypatch, handler)
    settings = sarvam.get_settings()
    settings.sarvam_llm_model = "sarvam-105b"
    monkeypatch.setattr(sarvam, "_llm_client", sarvam._client)
    result = asyncio.run(sarvam.assistant_reply(db, db.info["shop"], "Help me talk to a customer", "en-IN", None))
    assert result["destination"] == "Translator"
    assert result["pending_action"] is None
    assert db.scalar(select(func.count()).select_from(models.Sale)) == 0


def mock_assistant_tools(monkeypatch, calls, text="Please provide the missing details."):
    responses = [
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": f"intent-{index}", "type": "function",
             "function": {"name": name, "arguments": json.dumps(arguments)}}
            for index, (name, arguments) in enumerate(calls)
        ]},
        {"role": "assistant", "content": text},
    ]
    mock_translation(monkeypatch, lambda _: httpx.Response(200, json={"choices": [{"message": responses.pop(0)}]}))
    sarvam.get_settings().sarvam_llm_model = "sarvam-105b"
    monkeypatch.setattr(sarvam, "_llm_client", sarvam._client)


def test_customer_list_includes_zero_balances_and_excludes_other_shops(db):
    shop = db.info["shop"]
    other = models.Shop(name="Other shop")
    db.add(other)
    db.flush()
    db.add_all([
        models.Customer(shop_id=shop.id, name="Sita"),
        models.Customer(shop_id=other.id, name="Private customer"),
        models.CustomerLedger(shop_id=shop.id, customer_id=db.info["customer"].id,
                              entry_type="charge", amount=25),
    ])
    db.commit()
    result = sarvam.execute_tool(db, shop, "list_customers", {})
    assert result["total"] == result["shown"] == 2
    assert [(item["name"], item["balance"]) for item in result["customers"]] == [("Ravi", "25.00"), ("Sita", "0")]
    with pytest.raises(ValueError):
        sarvam.execute_tool(db, shop, "list_customers", {"shop_id": other.id})


@pytest.mark.parametrize("language", ["en-IN", "hi-IN", "ta-IN"])
def test_supplier_voice_creation_requires_confirmation_and_is_one_shot(monkeypatch, db, language):
    shop = db.info["shop"]
    mock_assistant_tools(monkeypatch, [
        ("create_supplier", {"name": "New Wholesale", "phone": "9876543210"}),
        ("navigate_app", {"page": "Dashboard"}),
    ])
    result = asyncio.run(sarvam.assistant_reply(db, shop, "Add supplier New Wholesale", language, None))
    assert result["destination"] == "Suppliers"  # A prepared write takes priority over incidental navigation.
    assert result["intent"] == "create_supplier" and result["confirmation_prompt"] is True
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 1
    action = db.get(models.PendingAction, result["pending_action"]["action_id"])
    confirmed = asyncio.run(sarvam.assistant_reply(db, shop, "Yes", language, result["conversation_id"]))
    assert "New Wholesale" in confirmed["text"]
    assert confirmed["pending_action"] is None and action.status == "completed"
    supplier = db.scalar(select(models.Supplier).where(models.Supplier.name == "New Wholesale"))
    assert supplier.shop_id == shop.id and supplier.phone == "9876543210"
    assert db.scalar(select(models.AuditLog).where(models.AuditLog.entity_id == supplier.id)).action == "supplier.created"
    with pytest.raises(HTTPException) as error:
        execute_pending(db, shop, action)
    assert error.value.status_code == 409
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 2


def test_supplier_cancellation_and_duplicate_validation_preserve_records(monkeypatch, db):
    shop = db.info["shop"]
    mock_assistant_tools(monkeypatch, [("create_supplier", {"name": "Cancelled supplier"})])
    result = asyncio.run(sarvam.assistant_reply(db, shop, "Add supplier Cancelled supplier", "en-IN", None))
    cancelled = asyncio.run(sarvam.assistant_reply(db, shop, "No", "en-IN", result["conversation_id"]))
    assert cancelled["pending_action"] is None
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 1
    for arguments in [{"name": " kumar traders "}, {"name": " "}, {"name": "X", "unknown": 1}]:
        with pytest.raises(ValueError):
            sarvam.execute_tool(db, shop, "create_supplier", arguments)
    other = models.Shop(name="Another shop")
    db.add(other)
    db.commit()
    pending = sarvam.execute_tool(db, other, "create_supplier", {"name": "Kumar Traders"})
    action = db.get(models.PendingAction, pending["action_id"])
    with pytest.raises(HTTPException) as error:
        execute_pending(db, shop, action)
    assert error.value.status_code == 404
    assert execute_pending(db, other, action)["name"] == "Kumar Traders"


def test_supplier_duplicate_created_during_review_cannot_be_confirmed(db):
    shop = db.info["shop"]
    pending = sarvam.execute_tool(db, shop, "create_supplier", {"name": "Concurrent supplier"})
    db.add(models.Supplier(shop_id=shop.id, name="Concurrent supplier"))
    db.commit()
    action = db.get(models.PendingAction, pending["action_id"])
    with pytest.raises(HTTPException) as error:
        execute_pending(db, shop, action)
    assert error.value.status_code == 409
    assert action.status == "pending"
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 2


def test_spoken_supplier_correction_updates_review_without_cancel_or_save(monkeypatch, db):
    shop = db.info["shop"]
    original = sarvam.execute_tool(db, shop, "create_supplier", {"name": "Biscuits", "phone": "9876543210"})
    mock_assistant_tools(monkeypatch, [("update_pending_supplier", {"name": "Anmol Tea"})])
    corrected = asyncio.run(sarvam.assistant_reply(
        db, shop, "Supplier's name is Anmol Tea, not biscuit.", "en-IN", None,
    ))
    assert corrected["pending_action"]["action_id"] == original["action_id"]
    assert corrected["confirmation_prompt"] is True and corrected["destination"] == "Suppliers"
    assert "correct" in corrected["text"] and "No new change" not in corrected["text"]
    action = db.get(models.PendingAction, original["action_id"])
    assert json.loads(action.payload) == {"name": "Anmol Tea", "phone": "9876543210"}
    assert "Anmol Tea" in action.summary and "Biscuits" not in action.summary
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 1
    assert db.scalar(select(models.AuditLog).where(models.AuditLog.entity_id == action.id)).action == "pending.corrected"
    confirmed = asyncio.run(sarvam.assistant_reply(db, shop, "Yes", "en-IN", corrected["conversation_id"]))
    assert confirmed["pending_action"] is None
    assert db.scalar(select(models.Supplier).where(models.Supplier.name == "Anmol Tea")).phone == "9876543210"
    assert db.scalar(select(models.Supplier).where(models.Supplier.name == "Biscuits")) is None


def test_spoken_cancel_and_replace_requires_confirmation_of_replacement(monkeypatch, db):
    shop = db.info["shop"]
    original = sarvam.execute_tool(db, shop, "create_supplier", {"name": "Biscuits"})
    mock_assistant_tools(monkeypatch, [
        ("cancel_pending_action", {}), ("create_supplier", {"name": "Anmol Tea"}),
    ])
    replacement = asyncio.run(sarvam.assistant_reply(db, shop, "Cancel the biscuit and add Anmol Tea.", "en-IN", None))
    assert db.get(models.PendingAction, original["action_id"]).status == "cancelled"
    assert replacement["pending_action"]["action_id"] != original["action_id"]
    assert replacement["confirmation_prompt"] is True and "No new change" not in replacement["text"]
    assert "Anmol Tea" in replacement["pending_action"]["summary"]
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 1
    assert db.scalar(select(func.count()).select_from(models.PendingAction).where(models.PendingAction.status == "pending")) == 1


def test_cancel_lookup_replace_finishes_on_preparation_without_an_extra_model_round(monkeypatch, db):
    shop = db.info["shop"]
    original = sarvam.execute_tool(db, shop, "create_supplier", {"name": "Biscuits"})
    calls = [
        ("cancel_pending_action", {}), ("search_supplier", {"query": "Anmol Tea"}),
        ("create_supplier", {"name": "Anmol Tea"}),
    ]

    def handler(request):
        assert calls, "A valid confirmation must not wait for another model response."
        name, arguments = calls.pop(0)
        return httpx.Response(200, json={"choices": [{"message": {
            "role": "assistant", "content": None, "tool_calls": [
                {"id": name, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}},
            ],
        }}]})

    mock_translation(monkeypatch, handler)
    sarvam.get_settings().sarvam_llm_model = "sarvam-105b"
    monkeypatch.setattr(sarvam, "_llm_client", sarvam._client)
    result = asyncio.run(sarvam.assistant_reply(db, shop, "Cancel biscuit and add Anmol Tea", "en-IN", None))
    assert calls == []
    assert db.get(models.PendingAction, original["action_id"]).status == "cancelled"
    assert result["confirmation_prompt"] is True and "Anmol Tea" in result["pending_action"]["summary"]
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 1


def test_pending_correction_is_shop_scoped_and_never_changes_other_action_types(db):
    shop = db.info["shop"]
    other = models.Shop(name="Other shop")
    db.add(other)
    db.commit()
    original = sarvam.execute_tool(db, shop, "create_supplier", {"name": "Biscuits"})
    with pytest.raises(ValueError):
        sarvam.execute_tool(db, other, "update_pending_supplier", {"name": "Anmol Tea"})
    with pytest.raises(ValueError):
        sarvam.execute_tool(db, other, "cancel_pending_action", {})
    assert db.get(models.PendingAction, original["action_id"]).status == "pending"
    sarvam.execute_tool(db, shop, "cancel_pending_action", {})
    action = create_pending(db, shop.id, "record_expense", {"category": "Rent", "amount": "50"}, summary="Rent")
    with pytest.raises(ValueError):
        sarvam.execute_tool(db, shop, "update_pending_supplier", {"name": "Anmol Tea"})
    assert action.status == "pending" and action.summary == "Rent"
    assert db.scalar(select(func.count()).select_from(models.Expense)) == 0


def test_transcription_glossary_contains_only_current_shop_and_pending_name(monkeypatch, client, db):
    headers = register_mobile(client)
    user_shop = client.get("/api/shop", headers=headers).json()["id"]
    db.add(models.Supplier(shop_id=user_shop, name="Anmol Tea"))
    create_pending(db, user_shop, "create_supplier", {"name": "Corrected Company", "phone": None}, summary="Supplier")
    db.commit()
    seen = {}

    async def transcribe(upload, mode, *, language, keyterms):
        seen.update(mode=mode, language=language, terms=keyterms)
        return {"transcript": "Anmol Tea"}

    monkeypatch.setattr("app.main.transcribe", transcribe)
    response = client.post("/api/voice/transcribe", headers=headers,
                           files={"file": ("voice.webm", b"audio", "audio/webm")},
                           data={"mode": "transcribe", "language": "en-IN"})
    assert response.status_code == 200
    assert seen == {"mode": "transcribe", "language": "en-IN", "terms": ["Corrected Company", "Anmol Tea"]}


@pytest.mark.parametrize("workflow,destination,ui_action,intent", [
    ("add_supplier", "Suppliers", "add_supplier", "create_supplier"),
    ("add_transaction", "Voice assistant", None, "clarify_transaction"),
])
def test_incomplete_workflow_routes_and_asks_without_guessing_a_write(monkeypatch, db, workflow, destination, ui_action, intent):
    mock_assistant_tools(monkeypatch, [
        ("start_workflow", {"workflow": workflow}), ("navigate_app", {"page": "Dashboard"}),
    ])
    result = asyncio.run(sarvam.assistant_reply(db, db.info["shop"], "Start this workflow", "en-IN", None))
    assert (result["destination"], result["ui_action"], result["intent"]) == (destination, ui_action, intent)
    assert result["clarification_required"] is True and result["confirmation_prompt"] is False
    assert result["pending_action"] is None
    assert db.scalar(select(func.count()).select_from(models.PendingAction)) == 0
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 1


@pytest.mark.parametrize("tool,arguments,destination", [
    ("list_customers", {}, "Customers"), ("navigate_app", {"page": "Translator"}, "Translator"),
])
def test_pending_action_does_not_block_unrelated_read_or_navigation(monkeypatch, db, tool, arguments, destination):
    shop = db.info["shop"]
    action = create_pending(db, shop.id, "record_expense", {"category": "Rent", "amount": "50"}, summary="Original expense")
    mock_assistant_tools(monkeypatch, [(tool, arguments)], text="Your requested result.")
    result = asyncio.run(sarvam.assistant_reply(db, shop, "Show me the requested feature", "en-IN", None))
    assert result["destination"] == destination and result["text"] == "Your requested result."
    assert result["confirmation_prompt"] is False
    assert result["pending_action"]["action_id"] == action.id
    db.refresh(action)
    assert action.status == "pending" and action.summary == "Original expense"
    assert db.scalar(select(func.count()).select_from(models.Expense)) == 0


def test_new_writes_are_blocked_while_existing_confirmation_remains(monkeypatch, db):
    shop = db.info["shop"]
    action = create_pending(db, shop.id, "record_expense", {"category": "Rent", "amount": "50"}, summary="Original expense")
    mock_assistant_tools(monkeypatch, [("create_supplier", {"name": "Not yet"})])
    result = asyncio.run(sarvam.assistant_reply(db, shop, "Add supplier Not yet", "en-IN", None))
    assert result["pending_action"]["action_id"] == action.id
    assert result["confirmation_prompt"] is True and "No new change" in result["text"]
    assert "error" in result["tool_results"][0]["result"]
    assert db.scalar(select(func.count()).select_from(models.PendingAction)) == 1
    assert db.scalar(select(func.count()).select_from(models.Supplier)) == 1


@pytest.mark.parametrize("legacy", [False, True])
def test_voice_migration_handles_new_and_existing_databases(tmp_path, legacy):
    database = tmp_path / "migration.db"
    if legacy:
        with sqlite3.connect(database) as connection:
            connection.executescript("""
                CREATE TABLE shops (
                    id VARCHAR(36) PRIMARY KEY, name VARCHAR(160) NOT NULL,
                    address VARCHAR(300) NOT NULL, language VARCHAR(10) NOT NULL,
                    allow_negative_stock BOOLEAN NOT NULL, created_at DATETIME NOT NULL
                );
                CREATE TABLE users (
                    id VARCHAR(36) PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE,
                    password_hash VARCHAR(255) NOT NULL, shop_id VARCHAR(36) NOT NULL UNIQUE REFERENCES shops(id)
                );
                INSERT INTO shops VALUES ('existing-shop', 'Original shop', '', 'ta-IN', 0, '2026-01-01');
                INSERT INTO users VALUES ('existing-user', 'existing@example.in', 'existing-hash', 'existing-shop');
            """)
    environment = {**os.environ, "DATABASE_URL": "sqlite:///" + str(database)}
    for _ in range(2):
        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head"],
            cwd=Path(__file__).resolve().parents[1], env=environment,
            capture_output=True, text=True, timeout=30,
        )
        assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as connection:
        assert "phone" in {row[1] for row in connection.execute("PRAGMA table_info(users)")}
        assert {"shopping_sessions", "shopping_orders", "shopping_order_items", "shopping_messages",
                "shopping_events", "shopping_turns"} <= {
            row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if legacy:
            assert connection.execute("SELECT id, language, language_configured FROM shops").fetchall() == [
                ("existing-shop", "ta-IN", 0),
            ]
            assert connection.execute("SELECT email, password_hash, phone FROM users").fetchall() == [
                ("existing@example.in", "existing-hash", None),
            ]
