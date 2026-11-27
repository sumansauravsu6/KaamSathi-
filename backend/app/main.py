import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from sqlalchemy import func, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models
from app.business import (
    calculate_summary, create_pending, create_product, create_purchase, create_sale,
    customer_balance, date_window, execute_pending, record_customer_payment, record_expense,
    reorder_suggestions, supplier_balance,
    lock_shop_inventory, reserved_quantities,
)
from app.config import get_settings
from app.db import Base, SessionLocal, engine, get_db
from app.sarvam import assistant_reply, identify_language, speak, transcribe, translate_text
from app.schemas import (
    AssistantRequest, ConfirmationRequest, CustomerCreate, ExpenseCreate, LoginRequest,
    PaymentCreate, ProductCreate, ProductUpdate, PurchaseCreate, RegisterRequest, SaleCreate,
    ShopUpdate, SupplierCreate, TranslationRequest, normalize_phone,
)
from app.security import create_token, current_user, hash_password, verify_password
from app.shopping import router as shopping_router

settings = get_settings()
app = FastAPI(title="KaamSaathi API", version="1.0.0", description="Voice-first kirana shop business management.")
app.include_router(shopping_router)
frontend_url = urlparse(settings.frontend_origin)
allowed_origins = [settings.frontend_origin]
if frontend_url.hostname == "localhost":
    allowed_origins.append(settings.frontend_origin.replace("localhost", "127.0.0.1"))
elif frontend_url.hostname == "127.0.0.1":
    allowed_origins.append(settings.frontend_origin.replace("127.0.0.1", "localhost"))
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _product_json(product: models.Product):
    return {
        "id": product.id, "name": product.name, "category": product.category, "sku": product.sku,
        "unit": product.unit, "purchase_price": str(product.purchase_price),
        "selling_price": str(product.selling_price), "stock": str(product.stock),
        "min_stock": str(product.min_stock), "is_archived": product.is_archived,
        "created_at": product.created_at.isoformat(),
    }


def _seed_demo():
    db = SessionLocal()
    try:
        user = db.scalar(select(models.User).where(models.User.email == "demo@kaamsaathi.in"))
        if user:
            return
        shop = models.Shop(name="Apna Kirana", address="12 Market Road, Bengaluru", language="hi-IN")
        db.add(shop)
        db.flush()
        user = models.User(email="demo@kaamsaathi.in", password_hash=hash_password("demo1234"), shop_id=shop.id)
        db.add(user)
        products = [
            ("Maggi", "Instant food", "pack", "12", "15", "25", "8"),
            ("Milk", "Dairy", "packet", "24", "30", "18", "6"),
            ("Bread", "Bakery", "loaf", "30", "40", "8", "4"),
            ("Rice", "Staples", "kg", "48", "60", "45", "10"),
            ("Sugar", "Staples", "kg", "38", "45", "12", "5"),
            ("Atta", "Staples", "kg", "36", "44", "24", "8"),
            ("Sunflower oil", "Cooking", "litre", "115", "135", "10", "4"),
            ("Parle-G biscuits", "Snacks", "pack", "4", "5", "35", "10"),
            ("Bath soap", "Personal care", "bar", "28", "35", "16", "5"),
            ("Shampoo", "Personal care", "sachet", "1", "2", "50", "15"),
            ("Toothpaste", "Personal care", "tube", "55", "68", "7", "4"),
        ]
        seeded_products = []
        for name, category, unit, cost, price, stock, threshold in products:
            product = models.Product(
                shop_id=shop.id, name=name, category=category, unit=unit,
                purchase_price=Decimal(cost), selling_price=Decimal(price),
                stock=Decimal(stock), min_stock=Decimal(threshold),
            )
            db.add(product)
            seeded_products.append(product)
        ravi = models.Customer(shop_id=shop.id, name="Ravi", phone="9000000001")
        sita = models.Customer(shop_id=shop.id, name="Sita", phone="9000000002")
        kumar = models.Supplier(shop_id=shop.id, name="Kumar Traders", phone="9000000003")
        db.add_all([ravi, sita, kumar])
        db.flush()
        db.add(models.CustomerLedger(
            shop_id=shop.id, customer_id=sita.id, amount=Decimal("480"), entry_type="charge",
        ))
        db.add(models.SupplierLedger(
            shop_id=shop.id, supplier_id=kumar.id, amount=Decimal("1200"), entry_type="charge",
        ))
        db.add(models.Expense(
            shop_id=shop.id, category="Electricity", amount=Decimal("350"),
            payment_method="upi", notes="Demo electricity bill",
        ))
        # Show a recent, explicitly demo sale in the dashboard and top-seller insights.
        sale = models.Sale(
            shop_id=shop.id, customer_id=None, payment_method="cash", total=Decimal("75"),
            idempotency_key="demo-seed-sale-magii",
            created_at=datetime.now(timezone.utc) - timedelta(hours=2),
        )
        db.add(sale)
        db.flush()
        maggi = seeded_products[0]
        db.add(models.SaleItem(
            sale_id=sale.id, product_id=maggi.id, quantity=Decimal("5"),
            unit_price=Decimal("15"), cost_price=Decimal("12"),
        ))
        maggi.stock -= Decimal("5")
        db.add(models.InventoryMovement(
            shop_id=shop.id, product_id=maggi.id, quantity_delta=Decimal("-5"),
            reason="sale", reference_id=sale.id,
        ))
        db.commit()
    finally:
        db.close()


@app.on_event("startup")
def startup():
    if settings.app_env != "development" and settings.jwt_secret_key == "replace-this-with-a-long-random-secret":
        raise RuntimeError("Set a unique JWT_SECRET_KEY before running KaamSaathi outside development.")
    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    if ("language_configured" not in {column["name"] for column in inspector.get_columns("shops")}
            or "phone" not in {column["name"] for column in inspector.get_columns("users")}):
        raise RuntimeError("Database upgrade required: from backend run `python -m alembic upgrade head`.")
    if settings.app_env == "development":
        _seed_demo()


@app.get("/health")
def health():
    return {"status": "ok", "service": "kaamsaathi-api"}


@app.post("/api/auth/register")
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    identifier = models.User.email == payload.email if payload.email else models.User.phone == payload.phone
    if db.scalar(select(models.User).where(identifier)):
        raise HTTPException(status_code=409, detail="An account with this email or mobile number already exists.")
    shop = models.Shop(name=payload.shop_name.strip(), language="hi-IN")
    db.add(shop)
    db.flush()
    user = models.User(email=payload.email, phone=payload.phone, password_hash=hash_password(payload.password), shop_id=shop.id)
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with this email or mobile number already exists.") from exc
    db.refresh(user)
    return {"access_token": create_token(user), "token_type": "bearer", "shop": {"id": shop.id, "name": shop.name}}


@app.post("/api/auth/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    identifier = (payload.identifier or payload.email or "").strip().lower()
    if "@" in identifier:
        query = models.User.email == identifier
    else:
        try:
            phone = normalize_phone(identifier)
        except ValueError as exc:
            raise HTTPException(status_code=401, detail="Email, mobile number or password is incorrect.") from exc
        query = models.User.phone == phone
    user = db.scalar(select(models.User).where(query))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email, mobile number or password is incorrect.")
    return {"access_token": create_token(user), "token_type": "bearer", "shop": {"id": user.shop.id, "name": user.shop.name}}


@app.post("/api/auth/demo")
def demo_login(db: Session = Depends(get_db)):
    if settings.app_env != "development":
        raise HTTPException(status_code=404, detail="Demo sign-in is disabled.")
    user = db.scalar(select(models.User).where(models.User.email == "demo@kaamsaathi.in"))
    if not user:
        raise HTTPException(status_code=503, detail="Demo account is not available. Restart the backend to seed demo data.")
    return {"access_token": create_token(user), "token_type": "bearer", "shop": {"id": user.shop.id, "name": user.shop.name}}


@app.get("/api/shop")
def get_shop(user: models.User = Depends(current_user)):
    shop = user.shop
    return {"id": shop.id, "name": shop.name, "address": shop.address, "language": shop.language,
            "language_configured": shop.language_configured,
            "is_demo": settings.app_env == "development" and user.email == "demo@kaamsaathi.in"}


@app.patch("/api/shop")
def update_shop(payload: ShopUpdate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    shop = db.get(models.Shop, user.shop_id)
    if payload.name is not None:
        if not payload.name.strip():
            raise HTTPException(status_code=422, detail="Shop name cannot be empty.")
        shop.name = payload.name.strip()
    if payload.address is not None:
        shop.address = payload.address
    if payload.language is not None:
        shop.language = payload.language
        shop.language_configured = True
    db.commit()
    return {"id": shop.id, "name": shop.name, "address": shop.address, "language": shop.language,
            "language_configured": shop.language_configured,
            "is_demo": settings.app_env == "development" and user.email == "demo@kaamsaathi.in"}


@app.get("/api/products")
def list_products(q: str = "", db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    query = select(models.Product).where(models.Product.shop_id == user.shop_id, models.Product.is_archived.is_(False))
    if q.strip():
        query = query.where(models.Product.name.ilike(f"%{q.strip()}%"))
    products = db.scalars(query.order_by(models.Product.name)).all()
    return [_product_json(product) for product in products]


@app.post("/api/products")
def add_product(payload: ProductCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    return _product_json(create_product(db, user.shop_id, payload))


@app.patch("/api/products/{product_id}")
def update_product(product_id: str, payload: ProductUpdate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    lock_shop_inventory(db, user.shop_id)
    product = db.scalar(select(models.Product).where(
        models.Product.id == product_id, models.Product.shop_id == user.shop_id,
        models.Product.is_archived.is_(False),
    ).execution_options(populate_existing=True))
    if not product:
        raise HTTPException(status_code=404, detail="Product not found.")
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if "stock" in changes and changes["stock"] < reserved_quantities(db, user.shop_id).get(product_id, Decimal("0")):
        raise HTTPException(status_code=409, detail="This quantity is reserved for accepted customer orders. Cancel those orders before reducing stock.")
    if "stock" in changes and changes["stock"] != product.stock:
        db.add(models.InventoryMovement(
            shop_id=user.shop_id, product_id=product.id, quantity_delta=changes["stock"] - product.stock,
            reason="adjustment",
        ))
    for key, value in changes.items():
        setattr(product, key, value)
    db.add(models.AuditLog(shop_id=user.shop_id, action="product.updated", entity_id=product.id))
    db.commit()
    db.refresh(product)
    return _product_json(product)


@app.delete("/api/products/{product_id}")
def archive_product(product_id: str, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    lock_shop_inventory(db, user.shop_id)
    product = db.scalar(select(models.Product).where(
        models.Product.id == product_id, models.Product.shop_id == user.shop_id,
    ))
    if not product:
        raise HTTPException(status_code=404, detail="Product not found.")
    if reserved_quantities(db, user.shop_id).get(product_id, Decimal("0")) > 0:
        raise HTTPException(status_code=409, detail="This product is reserved for accepted customer orders. Cancel or complete those orders before archiving.")
    product.is_archived = True
    db.add(models.AuditLog(shop_id=user.shop_id, action="product.archived", entity_id=product.id))
    db.commit()
    return {"archived": True}


@app.get("/api/products/low-stock")
def low_stock(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    products = db.scalars(select(models.Product).where(
        models.Product.shop_id == user.shop_id, models.Product.is_archived.is_(False),
        models.Product.stock <= models.Product.min_stock,
    ).order_by(models.Product.stock)).all()
    return [_product_json(product) for product in products]


@app.post("/api/sales")
def add_sale(payload: SaleCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    sale = db.scalar(select(models.Sale).where(
        models.Sale.shop_id == user.shop_id, models.Sale.idempotency_key == payload.idempotency_key,
    ))
    if sale:
        return {"status": "completed", "id": sale.id, "total": str(sale.total), "duplicate": True}
    customer = None
    if payload.payment_method == "credit" or payload.customer_id:
        if not payload.customer_id:
            raise HTTPException(status_code=422, detail="Choose a customer before recording a credit sale.")
        customer = db.scalar(select(models.Customer).where(
            models.Customer.shop_id == user.shop_id, models.Customer.id == payload.customer_id,
        ))
        if not customer:
            raise HTTPException(status_code=404, detail="Customer not found in this shop.")
    total = Decimal("0")
    items = []
    for item in payload.items:
        product = db.scalar(select(models.Product).where(
            models.Product.shop_id == user.shop_id, models.Product.id == item.product_id,
            models.Product.is_archived.is_(False),
        ))
        if not product:
            raise HTTPException(status_code=404, detail="One of the selected products was not found.")
        if not user.shop.allow_negative_stock and product.stock < item.quantity:
            raise HTTPException(status_code=409, detail=f"Not enough {product.name} in stock ({product.stock} available).")
        price = item.unit_price if item.unit_price is not None else product.selling_price
        total += price * item.quantity
        items.append(f"{item.quantity} {product.name}")
    summary = f"Sell {', '.join(items)} for ₹{total:.2f} ({payload.payment_method})."
    action = create_pending(
        db, user.shop_id, "create_sale", payload.model_dump(mode="json"),
        idempotency_key=payload.idempotency_key, summary=summary,
    )
    return {
        "status": "pending", "confirmation_required": True, "action_id": action.id,
        "summary": summary,
    }


@app.get("/api/sales")
def list_sales(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    sales = db.scalars(select(models.Sale).where(models.Sale.shop_id == user.shop_id)
                       .order_by(models.Sale.created_at.desc()).limit(100)).all()
    result = []
    for sale in sales:
        items = db.scalars(select(models.SaleItem).where(models.SaleItem.sale_id == sale.id)).all()
        result.append({
            "id": sale.id, "total": str(sale.total), "payment_method": sale.payment_method,
            "customer_id": sale.customer_id, "created_at": sale.created_at.isoformat(),
            "items": [{"product_id": item.product_id, "quantity": str(item.quantity), "unit_price": str(item.unit_price)} for item in items],
        })
    return result


@app.get("/api/customers")
def list_customers(q: str = "", db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    query = select(models.Customer).where(models.Customer.shop_id == user.shop_id)
    if q.strip():
        query = query.where(models.Customer.name.ilike(f"%{q.strip()}%"))
    return [{
        "id": c.id, "name": c.name, "phone": c.phone,
        "balance": str(customer_balance(db, user.shop_id, c.id)),
    } for c in db.scalars(query.order_by(models.Customer.name)).all()]


@app.post("/api/customers")
def add_customer(payload: CustomerCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    customer = models.Customer(shop_id=user.shop_id, **payload.model_dump())
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return {"id": customer.id, "name": customer.name, "phone": customer.phone, "balance": "0.00"}


@app.get("/api/customers/{customer_id}/ledger")
def customer_ledger(customer_id: str, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    customer = db.scalar(select(models.Customer).where(
        models.Customer.id == customer_id, models.Customer.shop_id == user.shop_id
    ))
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found.")
    entries = db.scalars(select(models.CustomerLedger).where(
        models.CustomerLedger.shop_id == user.shop_id, models.CustomerLedger.customer_id == customer_id,
    ).order_by(models.CustomerLedger.created_at.desc())).all()
    return {"balance": str(customer_balance(db, user.shop_id, customer_id)), "entries": [
        {"id": entry.id, "amount": str(entry.amount), "type": entry.entry_type, "created_at": entry.created_at.isoformat()}
        for entry in entries
    ]}


@app.post("/api/customers/{customer_id}/payments")
def customer_payment(customer_id: str, payload: PaymentCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    existing = db.scalar(select(models.CustomerLedger).where(
        models.CustomerLedger.idempotency_key == payload.idempotency_key,
    ))
    if existing:
        if existing.shop_id != user.shop_id or existing.customer_id != customer_id:
            raise HTTPException(status_code=409, detail="This request key has already been used.")
        return {"status": "completed", "balance": str(customer_balance(db, user.shop_id, customer_id)), "duplicate": True}
    customer = db.scalar(select(models.Customer).where(
        models.Customer.id == customer_id, models.Customer.shop_id == user.shop_id,
    ))
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found.")
    balance = customer_balance(db, user.shop_id, customer_id)
    if payload.amount > balance:
        raise HTTPException(status_code=409, detail=f"Payment exceeds the outstanding balance of ₹{balance}.")
    summary = f"Record ₹{payload.amount:.2f} payment from {customer.name}."
    action = create_pending(db, user.shop_id, "record_customer_payment", {
        "customer_id": customer_id, "amount": str(payload.amount),
    }, idempotency_key=payload.idempotency_key, summary=summary)
    return {"status": "pending", "confirmation_required": True, "action_id": action.id,
            "summary": summary}


@app.get("/api/suppliers")
def list_suppliers(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    suppliers = db.scalars(select(models.Supplier).where(models.Supplier.shop_id == user.shop_id)).all()
    return [{"id": s.id, "name": s.name, "phone": s.phone, "balance": str(supplier_balance(db, user.shop_id, s.id))} for s in suppliers]


@app.post("/api/suppliers")
def add_supplier(payload: SupplierCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    supplier = models.Supplier(shop_id=user.shop_id, **payload.model_dump())
    db.add(supplier)
    db.commit()
    db.refresh(supplier)
    return {"id": supplier.id, "name": supplier.name, "phone": supplier.phone, "balance": "0.00"}


@app.post("/api/purchases")
def add_purchase(payload: PurchaseCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    purchase = db.scalar(select(models.Purchase).where(
        models.Purchase.shop_id == user.shop_id, models.Purchase.idempotency_key == payload.idempotency_key,
    ))
    if purchase:
        return {"status": "completed", "id": purchase.id, "total": str(purchase.total), "duplicate": True}
    supplier = db.scalar(select(models.Supplier).where(
        models.Supplier.id == payload.supplier_id, models.Supplier.shop_id == user.shop_id,
    ))
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found.")
    total = Decimal("0")
    item_names = []
    for item in payload.items:
        product = db.scalar(select(models.Product).where(
            models.Product.id == item.product_id, models.Product.shop_id == user.shop_id,
            models.Product.is_archived.is_(False),
        ))
        if not product:
            raise HTTPException(status_code=404, detail="One of the selected products was not found.")
        total += item.quantity * item.unit_price
        item_names.append(f"{item.quantity} {product.name}")
    summary = f"Buy {', '.join(item_names)} from {supplier.name} for ₹{total:.2f} ({payload.payment_method})."
    action = create_pending(
        db, user.shop_id, "record_purchase", payload.model_dump(mode="json"),
        idempotency_key=payload.idempotency_key, summary=summary,
    )
    return {"status": "pending", "confirmation_required": True, "action_id": action.id,
            "summary": summary}


@app.get("/api/purchases")
def list_purchases(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    purchases = db.scalars(select(models.Purchase).where(
        models.Purchase.shop_id == user.shop_id,
    ).order_by(models.Purchase.created_at.desc()).limit(100)).all()
    result = []
    for purchase in purchases:
        supplier = db.get(models.Supplier, purchase.supplier_id)
        items = db.scalars(select(models.PurchaseItem).where(
            models.PurchaseItem.purchase_id == purchase.id,
        )).all()
        result.append({
            "id": purchase.id, "supplier": supplier.name if supplier else "Supplier",
            "total": str(purchase.total), "payment_method": purchase.payment_method,
            "created_at": purchase.created_at.isoformat(),
            "items": [{
                "product_id": item.product_id, "quantity": str(item.quantity),
                "unit_price": str(item.unit_price),
            } for item in items],
        })
    return result


@app.post("/api/suppliers/{supplier_id}/payments")
def supplier_payment(supplier_id: str, payload: PaymentCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    existing = db.scalar(select(models.SupplierLedger).where(models.SupplierLedger.idempotency_key == payload.idempotency_key))
    if existing:
        if existing.shop_id != user.shop_id or existing.supplier_id != supplier_id:
            raise HTTPException(status_code=409, detail="This request key has already been used.")
        return {"status": "completed", "balance": str(supplier_balance(db, user.shop_id, supplier_id)), "duplicate": True}
    balance = supplier_balance(db, user.shop_id, supplier_id)
    supplier = db.scalar(select(models.Supplier).where(
        models.Supplier.id == supplier_id, models.Supplier.shop_id == user.shop_id,
    ))
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found.")
    if payload.amount > balance:
        raise HTTPException(status_code=409, detail=f"Payment exceeds the outstanding balance of ₹{balance}.")
    summary = f"Record ₹{payload.amount:.2f} payment to {supplier.name}."
    action = create_pending(db, user.shop_id, "record_supplier_payment", {
        "supplier_id": supplier_id, "amount": str(payload.amount),
    }, idempotency_key=payload.idempotency_key, summary=summary)
    return {"status": "pending", "confirmation_required": True, "action_id": action.id,
            "summary": summary}


@app.get("/api/expenses")
def list_expenses(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    rows = db.scalars(select(models.Expense).where(models.Expense.shop_id == user.shop_id)
                      .order_by(models.Expense.created_at.desc()).limit(100)).all()
    return [{"id": row.id, "category": row.category, "amount": str(row.amount),
             "payment_method": row.payment_method, "notes": row.notes, "created_at": row.created_at.isoformat()} for row in rows]


@app.post("/api/expenses")
def add_expense(payload: ExpenseCreate, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    key = payload.idempotency_key or str(uuid.uuid4())
    existing = db.scalar(select(models.Expense).where(models.Expense.idempotency_key == key))
    if existing:
        if existing.shop_id != user.shop_id:
            raise HTTPException(status_code=409, detail="This request key has already been used.")
        return {"status": "completed", "id": existing.id, "amount": str(existing.amount), "duplicate": True}
    action_payload = payload.model_dump(mode="json")
    action_payload["idempotency_key"] = key
    summary = f"Record ₹{payload.amount:.2f} for {payload.category}."
    action = create_pending(
        db, user.shop_id, "record_expense", action_payload,
        idempotency_key=key, summary=summary,
    )
    return {"status": "pending", "confirmation_required": True, "action_id": action.id,
            "summary": summary}


@app.get("/api/dashboard/summary")
def dashboard(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    start, end = date_window(1)
    summary = calculate_summary(db, user.shop_id, start, end)
    low_count = db.scalar(select(func.count()).select_from(models.Product).where(
        models.Product.shop_id == user.shop_id, models.Product.is_archived.is_(False),
        models.Product.stock <= models.Product.min_stock,
    )) or 0
    customers = db.scalars(select(models.Customer).where(models.Customer.shop_id == user.shop_id)).all()
    suppliers = db.scalars(select(models.Supplier).where(models.Supplier.shop_id == user.shop_id)).all()
    customer_dues = sum((max(Decimal("0"), customer_balance(db, user.shop_id, c.id)) for c in customers), Decimal("0"))
    supplier_dues = sum((max(Decimal("0"), supplier_balance(db, user.shop_id, s.id)) for s in suppliers), Decimal("0"))
    recent = db.scalars(select(models.AuditLog).where(models.AuditLog.shop_id == user.shop_id)
                        .order_by(models.AuditLog.created_at.desc()).limit(5)).all()
    return {
        **{key: str(value) for key, value in summary.items()},
        "low_stock_count": low_count, "customer_dues": str(customer_dues), "supplier_dues": str(supplier_dues),
        "pending_customer_orders": db.scalar(select(func.count()).select_from(models.ShoppingOrder).where(
            models.ShoppingOrder.shop_id == user.shop_id,
            models.ShoppingOrder.status == "pending_shopkeeper_confirmation",
        )) or 0,
        "recent_activity": [{"action": event.action, "created_at": event.created_at.isoformat()} for event in recent],
    }


@app.get("/api/reports/daily")
def daily_report(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    start, end = date_window(1)
    return {key: str(value) for key, value in calculate_summary(db, user.shop_id, start, end).items()}


@app.get("/api/reports/weekly")
def weekly_report(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    start, end = date_window(7)
    return {key: str(value) for key, value in calculate_summary(db, user.shop_id, start, end).items()}


@app.get("/api/reports/reorder-suggestions")
def reorder_report(db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    return [{key: str(value) if isinstance(value, Decimal) else value for key, value in item.items()}
            for item in reorder_suggestions(db, user.shop_id)]


@app.post("/api/voice/transcribe")
async def transcribe_voice(file: UploadFile = File(...), mode: str | None = Form(default=None),
                           language: str | None = Form(default=None), db: Session = Depends(get_db),
                           user: models.User = Depends(current_user)):
    terms = []
    pending = db.scalar(select(models.PendingAction).where(
        models.PendingAction.shop_id == user.shop_id, models.PendingAction.status == "pending",
        models.PendingAction.action_type == "create_supplier",
    ))
    if pending:
        terms.append(json.loads(pending.payload)["name"])
    for model in (models.Supplier, models.Customer, models.Product):
        terms.extend(db.scalars(select(model.name).where(model.shop_id == user.shop_id)
                               .order_by(model.name).limit(20)).all())
    return await transcribe(file, mode, language=language, keyterms=terms)


@app.post("/api/voice/speak")
async def speak_voice(payload: dict, user: models.User = Depends(current_user)):
    text = payload.get("text", "")
    language = payload.get("language", user.shop.language)
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=422, detail="Text to speak cannot be empty.")
    audio = await speak(text.strip(), language)
    return Response(content=audio, media_type="audio/wav")


@app.post("/api/translation")
async def translate_conversation(payload: TranslationRequest, db: Session = Depends(get_db),
                                 user: models.User = Depends(current_user)):
    source = payload.source_language
    if source == "auto":
        if payload.language_probability is not None and payload.language_probability < 0.65:
            raise HTTPException(status_code=422, detail="The spoken language was unclear. Please speak a longer sentence or choose the language.")
        source = payload.detected_language or await identify_language(payload.text)
        if source == payload.target_language:
            return {"original_text": payload.text, "translated_text": payload.text,
                    "source_language": source, "target_language": payload.target_language, "same_language": True}
    terms = {term: "TERM" for term in payload.protected_terms}
    for model, kind in ((models.Product, "PRODUCT"), (models.Customer, "PERSON"), (models.Supplier, "BUSINESS")):
        terms.update({name: kind for name in db.scalars(select(model.name).where(model.shop_id == user.shop_id)).all()})
    if user.shop.address:
        terms[user.shop.address] = "ADDRESS"
    return await translate_text(payload.text, source, payload.target_language, terms)


@app.post("/api/assistant/respond")
async def respond(payload: AssistantRequest, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    return await assistant_reply(db, user.shop, payload.message, payload.language or user.shop.language, payload.conversation_id)


@app.post("/api/assistant/confirm")
def confirm(payload: ConfirmationRequest, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    action = db.scalar(select(models.PendingAction).where(
        models.PendingAction.id == payload.action_id, models.PendingAction.shop_id == user.shop_id,
    ))
    if not action:
        raise HTTPException(status_code=404, detail="Pending action not found.")
    if action.status != "pending":
        raise HTTPException(status_code=409, detail="This action has already been processed.")
    if not payload.confirmed:
        action.status = "cancelled"
        db.commit()
        return {"status": "cancelled", "message": "Nothing was changed."}
    result = execute_pending(db, user.shop, action)
    return {"status": "completed", "result": result}


@app.post("/api/assistant/cancel")
def cancel(payload: ConfirmationRequest, db: Session = Depends(get_db), user: models.User = Depends(current_user)):
    payload.confirmed = False
    return confirm(payload, db, user)
