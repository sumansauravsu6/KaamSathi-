import hashlib
import json
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import urlparse

import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from sqlalchemy import delete, exists, func, select
from sqlalchemy.orm import Session

from app import models, sarvam
from app.business import create_sale, lock_shop_inventory, reserved_quantities
from app.config import get_settings
from app.db import get_db
from app.schemas import SaleCreate, SaleItemInput
from app.security import current_user
from app.shopping_schemas import (
    CartDetailsInput, CartInput, CartItemInput, CheckoutInput, EmptyInput, Language,
    MessageInput, RevisionInput, ShoppingAssistantInput, SpeakInput, StatusInput,
    SubstitutionDecision, SubstitutionInput, TranslateInput,
)

def no_store(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(tags=["Accessible shopping"], dependencies=[Depends(no_store)])
PUBLIC = "/api/public/shops/{shop_id}"
MERCHANT = "/api/shopping"
RESERVED_STATES = {"accepted", "ready_for_collection"}
WHOLE_UNITS = {"pcs", "piece", "pieces", "pack", "packet", "packets", "packs", "loaf", "bar", "sachet", "tube"}
_rate_events: dict[tuple[str, str], deque] = defaultdict(deque)


def rate_limit(category: str, identity: str, limit: int, window: int = 60):
    now = time.monotonic()
    if len(_rate_events) > 2000:
        for key in list(_rate_events):
            if not _rate_events[key] or _rate_events[key][-1] <= now - 3600:
                del _rate_events[key]
        if len(_rate_events) > 2000:
            raise HTTPException(status_code=429, detail="Shopping is busy. Please try again shortly.")
    queue = _rate_events[(category, identity)]
    while queue and queue[0] <= now - window:
        queue.popleft()
    if len(queue) >= limit:
        raise HTTPException(status_code=429, detail="Too many requests. Please wait a moment before trying again.",
                            headers={"Retry-After": str(window)})
    queue.append(now)


def timestamp(value: datetime):
    return value.replace(tzinfo=value.tzinfo or timezone.utc).isoformat()


def public_shop(db: Session, shop_id: str):
    shop = db.get(models.Shop, shop_id)
    if not shop:
        raise HTTPException(status_code=404, detail="This shop was not found. Please choose the shop again.")
    return shop


def customer_order(shop_id: str, x_shopping_token: str | None = Header(default=None, max_length=200),
                   db: Session = Depends(get_db)):
    if not x_shopping_token or len(x_shopping_token) < 32:
        raise HTTPException(status_code=401, detail="Open or start your shopping session to access this order.")
    token_hash = hashlib.sha256(x_shopping_token.encode()).hexdigest()
    order = db.scalar(select(models.ShoppingOrder).join(
        models.ShoppingSession, models.ShoppingSession.id == models.ShoppingOrder.session_id,
    ).where(models.ShoppingOrder.shop_id == shop_id, models.ShoppingSession.shop_id == shop_id,
            models.ShoppingSession.token_hash == token_hash,
            models.ShoppingSession.expires_at > models.now_utc()))
    if not order:
        raise HTTPException(status_code=401, detail="This shopping session is invalid or has expired. Start a new session.")
    return order


def merchant_order(db: Session, shop_id: str, order_id: str):
    order = db.scalar(select(models.ShoppingOrder).where(
        models.ShoppingOrder.id == order_id, models.ShoppingOrder.shop_id == shop_id,
    ).execution_options(populate_existing=True))
    if not order:
        raise HTTPException(status_code=404, detail="Order not found in this shop.")
    return order


def check_order_id(order: models.ShoppingOrder, order_id: str):
    if order.id != order_id:
        raise HTTPException(status_code=404, detail="This order is not part of your shopping session.")


def order_items(db: Session, order: models.ShoppingOrder):
    return db.scalars(select(models.ShoppingOrderItem).where(
        models.ShoppingOrderItem.order_id == order.id,
    ).order_by(models.ShoppingOrderItem.name, models.ShoppingOrderItem.id)).all()


def item_json(item):
    return {
        "product_id": item.product_id, "name": item.name, "unit": item.unit,
        "quantity": str(item.quantity), "unit_price": str(item.unit_price),
        "line_total": str((item.quantity * item.unit_price).quantize(Decimal("0.01"))),
    }


def message_json(message: models.ShoppingMessage):
    return {"id": message.id, "sender": message.sender, "text": message.text,
            "language": message.language, "created_at": timestamp(message.created_at)}


def messages_json(db: Session, order_id: str):
    rows = db.scalars(select(models.ShoppingMessage).where(
        models.ShoppingMessage.order_id == order_id,
    ).order_by(models.ShoppingMessage.created_at.desc(), models.ShoppingMessage.id.desc()).limit(100)).all()
    return [message_json(row) for row in reversed(rows)]


def order_json(db: Session, order: models.ShoppingOrder):
    events = db.scalars(select(models.ShoppingEvent).where(
        models.ShoppingEvent.order_id == order.id,
    ).order_by(models.ShoppingEvent.created_at, models.ShoppingEvent.id)).all()
    return {
        "id": order.id, "shop_id": order.shop_id, "status": order.status,
        "revision": order.revision, "reviewed_revision": order.reviewed_revision,
        "checkout_confirmation_pending": order.checkout_confirmation_pending,
        "total": str(order.total), "items": [item_json(item) for item in order_items(db, order)],
        "customer_name": order.customer_name, "notes": order.notes, "sale_id": order.sale_id,
        "proposal": json.loads(order.proposal_json) if order.proposal_json else None,
        "created_at": timestamp(order.created_at), "updated_at": timestamp(order.updated_at),
        "messages": messages_json(db, order.id),
        "events": [{"id": event.id, "status": event.status, "note": event.note,
                    "created_at": timestamp(event.created_at)} for event in events],
    }


def catalogue(db: Session, shop_id: str, query: str = ""):
    reserved = select(func.coalesce(func.sum(models.ShoppingOrderItem.quantity), 0)).join(
        models.ShoppingOrder, models.ShoppingOrder.id == models.ShoppingOrderItem.order_id,
    ).where(
        models.ShoppingOrder.shop_id == shop_id, models.ShoppingOrder.status.in_(RESERVED_STATES),
        models.ShoppingOrderItem.product_id == models.Product.id,
    ).correlate(models.Product).scalar_subquery()
    statement = select(models.Product, (models.Product.stock - reserved).label("available")).where(
        models.Product.shop_id == shop_id, models.Product.is_archived.is_(False),
    )
    if query:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        statement = statement.where(models.Product.name.ilike(f"%{escaped}%", escape="\\")
                                    | models.Product.category.ilike(f"%{escaped}%", escape="\\"))
    products = db.execute(statement.order_by(models.Product.name).limit(1000)
                          .execution_options(populate_existing=True)).all()
    return [{"id": product.id, "name": product.name, "category": product.category,
             "unit": product.unit, "price": str(product.selling_price),
             "available": str(max(Decimal("0"), available))}
            for product, available in products]


def touch(order: models.ShoppingOrder):
    order.revision += 1
    order.updated_at = models.now_utc()


def revision_guard(db: Session, order: models.ShoppingOrder, revision: int, draft_only: bool = True):
    lock_shop_inventory(db, order.shop_id)
    db.refresh(order)
    if draft_only and order.status != "draft":
        raise HTTPException(status_code=409, detail="This order has already been submitted. Its cart can no longer be edited.")
    if order.revision != revision:
        raise HTTPException(status_code=409, detail="The order changed. Refresh it and review the latest details before trying again.")


def resolve_items(db: Session, shop_id: str, inputs: list[CartItemInput], exclude_order_id: str | None = None):
    if len({item.product_id for item in inputs}) != len(inputs):
        raise HTTPException(status_code=422, detail="Each product may appear only once. Update its quantity instead.")
    resolved = []
    reserved = reserved_quantities(db, shop_id, exclude_order_id)
    for item in inputs:
        product = db.scalar(select(models.Product).where(
            models.Product.shop_id == shop_id, models.Product.id == item.product_id,
            models.Product.is_archived.is_(False),
        ).execution_options(populate_existing=True))
        if not product:
            raise HTTPException(status_code=404, detail="One product is no longer available from this shop.")
        if product.unit.casefold().strip() in WHOLE_UNITS and item.quantity != item.quantity.to_integral_value():
            raise HTTPException(status_code=422, detail=f"{product.name} is sold by {product.unit}. Choose a whole number.")
        available = max(Decimal("0"), product.stock - reserved.get(product.id, Decimal("0")))
        if item.quantity > available:
            raise HTTPException(status_code=409, detail=f"Only {available} {product.unit} of {product.name} is available.")
        resolved.append((product, item.quantity))
    return resolved


def set_cart(db: Session, order: models.ShoppingOrder, payload: CartInput):
    revision_guard(db, order, payload.expected_revision)
    resolved = resolve_items(db, order.shop_id, payload.items)
    db.execute(delete(models.ShoppingOrderItem).where(models.ShoppingOrderItem.order_id == order.id))
    order.total = Decimal("0")
    for product, quantity in resolved:
        db.add(models.ShoppingOrderItem(order_id=order.id, product_id=product.id, name=product.name,
                                       unit=product.unit, quantity=quantity, unit_price=product.selling_price))
        order.total += (quantity * product.selling_price).quantize(Decimal("0.01"))
    order.reviewed_revision = None
    order.checkout_confirmation_pending = False
    touch(order)
    db.commit()
    return order_json(db, order)


def review_cart(db: Session, order: models.ShoppingOrder, revision: int):
    revision_guard(db, order, revision)
    items = order_items(db, order)
    if not items:
        raise HTTPException(status_code=422, detail="Your cart is empty. Add a product before checkout.")
    resolved = resolve_items(db, order.shop_id, [CartItemInput(product_id=item.product_id, quantity=item.quantity) for item in items])
    by_id = {product.id: product for product, _ in resolved}
    changed = False
    for item in items:
        product = by_id[item.product_id]
        if item.unit_price != product.selling_price or item.name != product.name or item.unit != product.unit:
            changed = True
        item.unit_price, item.name, item.unit = product.selling_price, product.name, product.unit
    if changed:
        touch(order)
    order.total = sum(((item.quantity * item.unit_price).quantize(Decimal("0.01")) for item in items), Decimal("0"))
    order.reviewed_revision = order.revision
    order.checkout_confirmation_pending = True
    db.commit()
    return order_json(db, order)


def event(db: Session, order: models.ShoppingOrder, note: str):
    db.add(models.ShoppingEvent(order_id=order.id, status=order.status, note=note))
    db.add(models.AuditLog(shop_id=order.shop_id, action=f"shopping.{order.status}", entity_id=order.id, details=note))


def checkout(db: Session, order: models.ShoppingOrder, payload: CheckoutInput):
    # One session owns one immutable submitted order, so duplicate checkout cannot create a second order.
    lock_shop_inventory(db, order.shop_id)
    db.refresh(order)
    if order.status != "draft":
        return order_json(db, order)
    revision_guard(db, order, payload.expected_revision)
    if not order.checkout_confirmation_pending or order.reviewed_revision != order.revision:
        raise HTTPException(status_code=409, detail="Review the current cart and total before confirming this order.")
    items = order_items(db, order)
    if not items:
        raise HTTPException(status_code=422, detail="Your cart is empty.")
    resolved = resolve_items(db, order.shop_id, [CartItemInput(product_id=item.product_id, quantity=item.quantity) for item in items])
    current = {product.id: product for product, _ in resolved}
    if any(item.unit_price != current[item.product_id].selling_price or item.unit != current[item.product_id].unit for item in items):
        order.checkout_confirmation_pending = False
        order.reviewed_revision = None
        touch(order)
        db.commit()
        raise HTTPException(status_code=409, detail="A product price or unit changed. Review the cart again before placing the order.")
    order.status = "pending_shopkeeper_confirmation"
    order.checkout_confirmation_pending = False
    touch(order)
    event(db, order, "Customer explicitly confirmed the order. Awaiting shopkeeper acceptance. Pay at the shop; no online payment was taken.")
    db.commit()
    return order_json(db, order)


def change_status(db: Session, order: models.ShoppingOrder, payload: StatusInput):
    lock_shop_inventory(db, order.shop_id)
    db.refresh(order)
    if order.status == payload.status:
        if order.status == "completed" and payload.payment_method:
            sale = db.get(models.Sale, order.sale_id)
            if sale and sale.payment_method != payload.payment_method:
                raise HTTPException(status_code=409, detail="This order was completed with a different recorded payment method.")
        return order_json(db, order)
    revision_guard(db, order, payload.expected_revision, draft_only=False)
    allowed = {
        "pending_shopkeeper_confirmation": {"accepted", "rejected", "cancelled"},
        "accepted": {"ready_for_collection", "cancelled"},
        "ready_for_collection": {"completed", "cancelled"},
    }
    if payload.status not in allowed.get(order.status, set()):
        raise HTTPException(status_code=409, detail="This order cannot move to that status.")
    if payload.status == "rejected" and not payload.note.strip():
        raise HTTPException(status_code=422, detail="Give the customer a written reason for rejection.")
    if payload.status == "accepted":
        if order.proposal_json:
            raise HTTPException(status_code=409, detail="Wait for the customer to approve or decline the proposed substitution.")
        resolve_items(db, order.shop_id, [CartItemInput(product_id=item.product_id, quantity=item.quantity) for item in order_items(db, order)])
    if payload.status == "completed":
        if not payload.payment_method:
            raise HTTPException(status_code=422, detail="Select the payment already collected at the shop: cash or UPI. No payment is processed online.")
        resolve_items(db, order.shop_id, [
            CartItemInput(product_id=item.product_id, quantity=item.quantity) for item in order_items(db, order)
        ], exclude_order_id=order.id)
        sale, _ = create_sale(db, public_shop(db, order.shop_id), SaleCreate(
            items=[SaleItemInput(product_id=item.product_id, quantity=item.quantity, unit_price=item.unit_price)
                   for item in order_items(db, order)],
            payment_method=payload.payment_method, idempotency_key=f"shopping-order:{order.id}",
        ), commit=False, exclude_order_id=order.id)
        order.sale_id = sale.id
    order.status = payload.status
    order.proposal_json = None
    touch(order)
    event(db, order, payload.note.strip() or {
        "accepted": "The shopkeeper accepted your order and reserved the items.",
        "ready_for_collection": "Your order is ready for collection.",
        "completed": "Collected at the shop. The shopkeeper recorded the payment already received.",
        "cancelled": "The shopkeeper cancelled this order. Reserved stock has been released.",
    }.get(payload.status, "Order status updated."))
    db.commit()
    return order_json(db, order)


def shop_link(shop: models.Shop):
    settings = get_settings()
    base = (settings.public_shop_base_url or settings.frontend_origin).rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.query or parsed.fragment or parsed.username:
        raise HTTPException(status_code=503, detail="Set PUBLIC_SHOP_BASE_URL to the reachable frontend HTTP(S) URL.")
    path = f"/shop/{shop.id}"
    return {"shop_id": shop.id, "shop_name": shop.name, "path": path, "url": base + path,
            "qr_path": f"/api/public/shops/{shop.id}/qr.svg",
            "local_only": parsed.hostname in {"localhost", "127.0.0.1", "::1"}}


@router.get("/api/public/shops")
def find_public_shops(request: Request, q: str = Query(min_length=2, max_length=100),
                      db: Session = Depends(get_db)):
    rate_limit("shop-search", request.client.host if request.client else "unknown", 60)
    query = q.strip()
    if len(query) < 2:
        raise HTTPException(status_code=422, detail="Enter at least two characters of the shop name.")
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    rows = db.scalars(select(models.Shop).where(
        models.Shop.name.ilike(f"%{escaped}%", escape="\\"),
        exists(select(models.Product.id).where(
            models.Product.shop_id == models.Shop.id, models.Product.is_archived.is_(False))),
    ).order_by(models.Shop.name, models.Shop.id).limit(10)).all()
    return [{"id": shop.id, "name": shop.name, "address": shop.address} for shop in rows]


@router.get(PUBLIC)
def get_public_shop(shop_id: str, db: Session = Depends(get_db)):
    shop = public_shop(db, shop_id)
    return {"id": shop.id, "name": shop.name, "address": shop.address, "language": shop.language,
            "is_demo": bool(db.scalar(select(models.User.id).where(
                models.User.shop_id == shop.id, models.User.email == "demo@kaamsaathi.in"))),
            "products": catalogue(db, shop.id)}


@router.get(PUBLIC + "/qr.svg")
def public_qr(shop_id: str, db: Session = Depends(get_db)):
    url = shop_link(public_shop(db, shop_id))["url"]
    image = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=4)
    return Response(image.to_string(), media_type="image/svg+xml",
                    headers={"Content-Disposition": f'inline; filename="kaamsaathi-{shop_id}.svg"',
                             "Cache-Control": "public, max-age=300"})


@router.post(PUBLIC + "/sessions")
def new_session(shop_id: str, payload: EmptyInput, request: Request, db: Session = Depends(get_db)):
    public_shop(db, shop_id)
    rate_limit("sessions", request.client.host if request.client else "unknown", 120, 3600)
    token = secrets.token_urlsafe(32)
    session = models.ShoppingSession(shop_id=shop_id, token_hash=hashlib.sha256(token.encode()).hexdigest(),
                                     expires_at=models.now_utc() + timedelta(days=7))
    db.add(session)
    db.flush()
    order = models.ShoppingOrder(shop_id=shop_id, session_id=session.id)
    db.add(order)
    db.commit()
    return {"session_token": token, "cart": order_json(db, order)}


@router.get(PUBLIC + "/cart")
def get_cart(order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    return order_json(db, order)


@router.put(PUBLIC + "/cart")
def update_cart(payload: CartInput, order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    rate_limit("cart", order.session_id, 60)
    return set_cart(db, order, payload)


@router.patch(PUBLIC + "/cart")
def update_details(payload: CartDetailsInput, order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    revision_guard(db, order, payload.expected_revision)
    order.customer_name, order.notes = payload.customer_name, payload.notes
    order.checkout_confirmation_pending = False
    order.reviewed_revision = None
    touch(order)
    db.commit()
    return order_json(db, order)


@router.post(PUBLIC + "/cart/review")
def review(payload: RevisionInput, order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    return review_cart(db, order, payload.expected_revision)


@router.post(PUBLIC + "/checkout")
def confirm_checkout(payload: CheckoutInput, order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    rate_limit("checkout", order.session_id, 20)
    return checkout(db, order, payload)


@router.get(PUBLIC + "/orders/{order_id}")
def get_customer_order(order_id: str, order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    check_order_id(order, order_id)
    return order_json(db, order)


@router.post(PUBLIC + "/orders/{order_id}/cancel")
def cancel_customer_order(order_id: str, payload: RevisionInput, order: models.ShoppingOrder = Depends(customer_order),
                          db: Session = Depends(get_db)):
    check_order_id(order, order_id)
    revision_guard(db, order, payload.expected_revision, draft_only=False)
    if order.status == "cancelled":
        return order_json(db, order)
    if order.status not in {"pending_shopkeeper_confirmation", "accepted", "ready_for_collection"}:
        raise HTTPException(status_code=409, detail="Only an uncompleted submitted order can be cancelled.")
    order.status = "cancelled"
    order.proposal_json = None
    touch(order)
    event(db, order, "Customer cancelled the order. Any reserved stock has been released.")
    db.commit()
    return order_json(db, order)


@router.get(PUBLIC + "/orders/{order_id}/messages")
def get_customer_messages(order_id: str, order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    check_order_id(order, order_id)
    return messages_json(db, order.id)


def add_message(db: Session, order: models.ShoppingOrder, payload: MessageInput, sender: str):
    rate_limit("messages", order.id + sender, 30)
    message = models.ShoppingMessage(order_id=order.id, sender=sender, **payload.model_dump())
    db.add(message)
    order.updated_at = models.now_utc()
    db.commit()
    db.refresh(message)
    return message_json(message)


@router.post(PUBLIC + "/orders/{order_id}/messages")
def customer_message(order_id: str, payload: MessageInput, order: models.ShoppingOrder = Depends(customer_order),
                     db: Session = Depends(get_db)):
    check_order_id(order, order_id)
    return add_message(db, order, payload, "customer")


@router.post(PUBLIC + "/voice/transcribe")
async def customer_transcribe(file: UploadFile = File(...), mode: str | None = Form(default=None),
                              language: Language | None = Form(default=None),
                              order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    rate_limit("stt", order.session_id, 20)
    return await sarvam.transcribe(file, mode, language=language,
                                   keyterms=[item["name"] for item in catalogue(db, order.shop_id)[:40]])


@router.post(PUBLIC + "/voice/speak")
async def customer_speak(payload: SpeakInput, order: models.ShoppingOrder = Depends(customer_order)):
    rate_limit("tts", order.session_id, 40)
    return Response(await sarvam.speak(payload.text, payload.language), media_type="audio/wav",
                    headers={"Cache-Control": "no-store"})


@router.post(PUBLIC + "/translate")
async def customer_translate(payload: TranslateInput, order: models.ShoppingOrder = Depends(customer_order),
                             db: Session = Depends(get_db)):
    rate_limit("translate", order.session_id, 20)
    if payload.source_language == payload.target_language:
        return {"original_text": payload.text, "translated_text": payload.text,
                "source_language": payload.source_language, "target_language": payload.target_language}
    return await sarvam.translate_text(payload.text, payload.source_language, payload.target_language,
                                       {item["name"]: "PRODUCT" for item in catalogue(db, order.shop_id)})


@router.post(PUBLIC + "/assistant")
async def customer_assistant(payload: ShoppingAssistantInput, order: models.ShoppingOrder = Depends(customer_order),
                             db: Session = Depends(get_db)):
    from app.shopping_ai import respond
    rate_limit("assistant", order.session_id, 20)
    return await respond(db, order, payload)


@router.get(MERCHANT + "/link")
def merchant_link(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    result = shop_link(user.shop)
    result["pending_count"] = len(db.scalars(select(models.ShoppingOrder.id).where(
        models.ShoppingOrder.shop_id == user.shop_id, models.ShoppingOrder.status == "pending_shopkeeper_confirmation",
    )).all())
    return result


@router.get(MERCHANT + "/orders")
def merchant_orders(user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    enquiry = exists().where(models.ShoppingMessage.order_id == models.ShoppingOrder.id)
    orders = db.scalars(select(models.ShoppingOrder).where(
        models.ShoppingOrder.shop_id == user.shop_id,
        (models.ShoppingOrder.status != "draft") | enquiry,
    ).order_by(models.ShoppingOrder.updated_at.desc()).limit(100)).all()
    return [order_json(db, order) for order in orders]


@router.get(MERCHANT + "/orders/{order_id}")
def merchant_order_details(order_id: str, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    return order_json(db, merchant_order(db, user.shop_id, order_id))


@router.post(MERCHANT + "/orders/{order_id}/status")
def merchant_status(order_id: str, payload: StatusInput, user: models.User = Depends(current_user),
                    db: Session = Depends(get_db)):
    return change_status(db, merchant_order(db, user.shop_id, order_id), payload)


@router.get(MERCHANT + "/orders/{order_id}/messages")
def merchant_messages(order_id: str, user: models.User = Depends(current_user), db: Session = Depends(get_db)):
    order = merchant_order(db, user.shop_id, order_id)
    return messages_json(db, order.id)


@router.post(MERCHANT + "/orders/{order_id}/messages")
def merchant_send_message(order_id: str, payload: MessageInput, user: models.User = Depends(current_user),
                          db: Session = Depends(get_db)):
    return add_message(db, merchant_order(db, user.shop_id, order_id), payload, "shopkeeper")


@router.post(MERCHANT + "/orders/{order_id}/substitutions")
def propose_substitution(order_id: str, payload: SubstitutionInput, user: models.User = Depends(current_user),
                          db: Session = Depends(get_db)):
    order = merchant_order(db, user.shop_id, order_id)
    revision_guard(db, order, payload.expected_revision, draft_only=False)
    if order.status != "pending_shopkeeper_confirmation":
        raise HTTPException(status_code=409, detail="Substitutions can be proposed only before accepting the order.")
    items = order_items(db, order)
    if payload.product_id not in {item.product_id for item in items} or payload.product_id == payload.replacement_product_id:
        raise HTTPException(status_code=422, detail="Choose an ordered product and a different replacement.")
    replacement, _ = resolve_items(db, user.shop_id, [
        CartItemInput(product_id=payload.replacement_product_id, quantity=payload.quantity),
    ])[0]
    proposed = [item_json(item) for item in items if item.product_id != payload.product_id]
    existing = next((item for item in proposed if item["product_id"] == replacement.id), None)
    quantity = payload.quantity + (Decimal(existing["quantity"]) if existing else Decimal("0"))
    resolve_items(db, user.shop_id, [CartItemInput(product_id=replacement.id, quantity=quantity)])
    proposed = [item for item in proposed if item["product_id"] != replacement.id]
    proposed.append({"product_id": replacement.id, "name": replacement.name, "unit": replacement.unit,
                     "quantity": str(quantity), "unit_price": str(replacement.selling_price),
                     "line_total": str((quantity * replacement.selling_price).quantize(Decimal("0.01")))})
    proposal = {
        "original_product_id": payload.product_id, "replacement_product_id": replacement.id,
        "replacement_name": replacement.name, "replacement_unit": replacement.unit,
        "quantity": str(quantity), "unit_price": str(replacement.selling_price),
        "total": str(sum((Decimal(item["line_total"]) for item in proposed), Decimal("0"))),
        "note": payload.note.strip(), "items": proposed,
    }
    order.proposal_json = json.dumps(proposal)
    touch(order)
    event(db, order, f"Substitution offered: {quantity} {replacement.unit} {replacement.name}. New total INR {proposal['total']}. Customer approval is required.")
    db.commit()
    return order_json(db, order)


@router.post(PUBLIC + "/orders/{order_id}/substitution")
def decide_substitution(order_id: str, payload: SubstitutionDecision,
                        order: models.ShoppingOrder = Depends(customer_order), db: Session = Depends(get_db)):
    check_order_id(order, order_id)
    revision_guard(db, order, payload.expected_revision, draft_only=False)
    if order.status != "pending_shopkeeper_confirmation" or not order.proposal_json:
        raise HTTPException(status_code=409, detail="There is no current substitution proposal to decide.")
    proposal = json.loads(order.proposal_json)
    if payload.accept:
        proposed = proposal["items"]
        resolve_items(db, order.shop_id, [CartItemInput(
            product_id=proposal["replacement_product_id"], quantity=proposal["quantity"],
        )])
        replacement = db.get(models.Product, proposal["replacement_product_id"])
        if replacement.selling_price != Decimal(proposal["unit_price"]) or replacement.unit != proposal["replacement_unit"]:
            raise HTTPException(status_code=409, detail="The replacement price or unit changed. Ask the shopkeeper for a new proposal.")
        previous = [item_json(item) for item in order_items(db, order)]
        db.execute(delete(models.ShoppingOrderItem).where(models.ShoppingOrderItem.order_id == order.id))
        for item in proposed:
            db.add(models.ShoppingOrderItem(order_id=order.id, product_id=item["product_id"], name=item["name"],
                                           unit=item["unit"], quantity=Decimal(item["quantity"]),
                                           unit_price=Decimal(item["unit_price"])))
        order.total = Decimal(proposal["total"])
        db.add(models.AuditLog(shop_id=order.shop_id, action="shopping.substitution_approved", entity_id=order.id,
                               details=json.dumps({"before": previous, "after": proposed})))
    order.proposal_json = None
    touch(order)
    event(db, order, "Customer approved the substitution and its total." if payload.accept else
          "Customer declined the substitution. Original order remains unchanged.")
    db.commit()
    return order_json(db, order)
