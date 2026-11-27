import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app import models
from app.schemas import ExpenseCreate, ProductCreate, PurchaseCreate, SaleCreate, SupplierCreate

ZERO = Decimal("0")


def lock_shop_inventory(db: Session, shop_id: str):
    # SQLite has no SELECT FOR UPDATE; a no-op write serializes inventory decisions.
    if db.get_bind().dialect.name == "sqlite":
        db.execute(update(models.Shop).where(models.Shop.id == shop_id).values(name=models.Shop.name))
    else:
        db.execute(select(models.Shop.id).where(models.Shop.id == shop_id).with_for_update())


def reserved_quantities(db: Session, shop_id: str, exclude_order_id: str | None = None):
    query = select(models.ShoppingOrderItem.product_id, func.sum(models.ShoppingOrderItem.quantity)).join(
        models.ShoppingOrder, models.ShoppingOrder.id == models.ShoppingOrderItem.order_id,
    ).where(models.ShoppingOrder.shop_id == shop_id,
            models.ShoppingOrder.status.in_(["accepted", "ready_for_collection"]))
    if exclude_order_id:
        query = query.where(models.ShoppingOrder.id != exclude_order_id)
    return dict(db.execute(query.group_by(models.ShoppingOrderItem.product_id)).all())


def customer_balance(db: Session, shop_id: str, customer_id: str) -> Decimal:
    rows = db.execute(
        select(models.CustomerLedger.entry_type, func.sum(models.CustomerLedger.amount))
        .where(models.CustomerLedger.shop_id == shop_id, models.CustomerLedger.customer_id == customer_id)
        .group_by(models.CustomerLedger.entry_type)
    ).all()
    totals = {kind: amount or ZERO for kind, amount in rows}
    return totals.get("charge", ZERO) - totals.get("payment", ZERO) + totals.get("reversal", ZERO)


def supplier_balance(db: Session, shop_id: str, supplier_id: str) -> Decimal:
    rows = db.execute(
        select(models.SupplierLedger.entry_type, func.sum(models.SupplierLedger.amount))
        .where(models.SupplierLedger.shop_id == shop_id, models.SupplierLedger.supplier_id == supplier_id)
        .group_by(models.SupplierLedger.entry_type)
    ).all()
    totals = {kind: amount or ZERO for kind, amount in rows}
    return totals.get("charge", ZERO) - totals.get("payment", ZERO) + totals.get("reversal", ZERO)


def create_product(db: Session, shop_id: str, payload: ProductCreate) -> models.Product:
    product = models.Product(shop_id=shop_id, **payload.model_dump())
    db.add(product)
    db.flush()
    if product.stock:
        db.add(models.InventoryMovement(shop_id=shop_id, product_id=product.id, quantity_delta=product.stock, reason="opening"))
    db.add(models.AuditLog(shop_id=shop_id, action="product.created", entity_id=product.id))
    db.commit()
    db.refresh(product)
    return product


def create_sale(db: Session, shop: models.Shop, payload: SaleCreate, *,
                commit: bool = True, exclude_order_id: str | None = None):
    lock_shop_inventory(db, shop.id)
    duplicate = db.scalar(select(models.Sale).where(
        models.Sale.shop_id == shop.id, models.Sale.idempotency_key == payload.idempotency_key
    ))
    if duplicate:
        if exclude_order_id:
            order = db.get(models.ShoppingOrder, exclude_order_id)
            if not order or order.sale_id != duplicate.id:
                raise HTTPException(status_code=409, detail="A different sale already uses this order's request key. The order was not completed.")
        return duplicate, True
    customer = None
    if payload.payment_method == "credit" or payload.customer_id:
        if not payload.customer_id:
            raise HTTPException(status_code=422, detail="Choose a customer before recording a credit sale.")
        customer = db.scalar(select(models.Customer).where(
            models.Customer.shop_id == shop.id, models.Customer.id == payload.customer_id
        ))
        if not customer:
            raise HTTPException(status_code=404, detail="Customer not found in this shop.")
    products = {}
    requested = {}
    reserved = reserved_quantities(db, shop.id, exclude_order_id)
    total = ZERO
    computed = []
    for item in payload.items:
        product = db.scalar(select(models.Product).where(
            models.Product.shop_id == shop.id, models.Product.id == item.product_id,
            models.Product.is_archived.is_(False),
        ).execution_options(populate_existing=True))
        if not product:
            raise HTTPException(status_code=404, detail="One of the selected products was not found.")
        requested[product.id] = requested.get(product.id, ZERO) + item.quantity
        available = product.stock - reserved.get(product.id, ZERO)
        if available < requested[product.id] and (not shop.allow_negative_stock or reserved.get(product.id, ZERO) > 0):
            raise HTTPException(status_code=409, detail=f"Not enough {product.name} in stock ({max(available, ZERO)} available after customer reservations).")
        price = item.unit_price if item.unit_price is not None else product.selling_price
        total += (price * item.quantity).quantize(Decimal("0.01"))
        products[product.id] = product
        computed.append((item, product, price))
    sale = models.Sale(
        shop_id=shop.id, customer_id=customer.id if customer else None, payment_method=payload.payment_method,
        total=total.quantize(Decimal("0.01")), idempotency_key=payload.idempotency_key,
    )
    db.add(sale)
    db.flush()
    for item, product, price in computed:
        product.stock -= item.quantity
        db.add(models.SaleItem(
            sale_id=sale.id, product_id=product.id, quantity=item.quantity, unit_price=price,
            cost_price=product.purchase_price,
        ))
        db.add(models.InventoryMovement(
            shop_id=shop.id, product_id=product.id, quantity_delta=-item.quantity, reason="sale", reference_id=sale.id,
        ))
    if payload.payment_method == "credit":
        db.add(models.CustomerLedger(
            shop_id=shop.id, customer_id=customer.id, amount=sale.total, entry_type="charge", reference_id=sale.id,
        ))
    db.add(models.AuditLog(shop_id=shop.id, action="sale.created", entity_id=sale.id, details=str(sale.total)))
    if commit:
        db.commit()
        db.refresh(sale)
    else:
        db.flush()
    return sale, False


def record_customer_payment(db: Session, shop_id: str, customer_id: str, amount: Decimal, key: str):
    existing = db.scalar(select(models.CustomerLedger).where(models.CustomerLedger.idempotency_key == key))
    if existing:
        if existing.shop_id != shop_id or existing.customer_id != customer_id:
            raise HTTPException(status_code=409, detail="This request key was already used for a different payment.")
        return customer_balance(db, shop_id, customer_id), True
    customer = db.scalar(select(models.Customer).where(
        models.Customer.shop_id == shop_id, models.Customer.id == customer_id
    ))
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found in this shop.")
    balance = customer_balance(db, shop_id, customer_id)
    if amount > balance:
        raise HTTPException(status_code=409, detail=f"Payment exceeds the outstanding balance of ₹{balance}.")
    db.add(models.CustomerLedger(
        shop_id=shop_id, customer_id=customer_id, amount=amount.quantize(Decimal("0.01")),
        entry_type="payment", idempotency_key=key,
    ))
    db.add(models.AuditLog(shop_id=shop_id, action="customer.payment", entity_id=customer_id, details=str(amount)))
    db.commit()
    return customer_balance(db, shop_id, customer_id), False


def create_purchase(db: Session, shop_id: str, payload: PurchaseCreate):
    lock_shop_inventory(db, shop_id)
    existing = db.scalar(select(models.Purchase).where(
        models.Purchase.shop_id == shop_id, models.Purchase.idempotency_key == payload.idempotency_key
    ).execution_options(populate_existing=True))
    if existing:
        return existing, True
    supplier = db.scalar(select(models.Supplier).where(
        models.Supplier.shop_id == shop_id, models.Supplier.id == payload.supplier_id
    ))
    if not supplier:
        raise HTTPException(status_code=404, detail="Supplier not found in this shop.")
    resolved = []
    total = ZERO
    for item in payload.items:
        product = db.scalar(select(models.Product).where(
            models.Product.shop_id == shop_id, models.Product.id == item.product_id
        ).execution_options(populate_existing=True))
        if not product:
            raise HTTPException(status_code=404, detail="One of the selected products was not found.")
        total += item.quantity * item.unit_price
        resolved.append((item, product))
    purchase = models.Purchase(
        shop_id=shop_id, supplier_id=supplier.id, total=total.quantize(Decimal("0.01")),
        payment_method=payload.payment_method, idempotency_key=payload.idempotency_key,
    )
    db.add(purchase)
    db.flush()
    for item, product in resolved:
        product.stock += item.quantity
        product.purchase_price = item.unit_price
        db.add(models.PurchaseItem(purchase_id=purchase.id, product_id=product.id, quantity=item.quantity, unit_price=item.unit_price))
        db.add(models.InventoryMovement(
            shop_id=shop_id, product_id=product.id, quantity_delta=item.quantity, reason="purchase", reference_id=purchase.id,
        ))
    if payload.payment_method == "credit":
        db.add(models.SupplierLedger(
            shop_id=shop_id, supplier_id=supplier.id, amount=purchase.total, entry_type="charge", reference_id=purchase.id,
        ))
    db.add(models.AuditLog(shop_id=shop_id, action="purchase.created", entity_id=purchase.id, details=str(purchase.total)))
    db.commit()
    db.refresh(purchase)
    return purchase, False


def record_expense(db: Session, shop_id: str, payload: ExpenseCreate):
    data = payload.model_dump()
    key = data.pop("idempotency_key", None)
    if key:
        existing = db.scalar(select(models.Expense).where(models.Expense.idempotency_key == key))
        if existing:
            if existing.shop_id != shop_id:
                raise HTTPException(status_code=409, detail="This request key has already been used.")
            return existing
    expense = models.Expense(shop_id=shop_id, idempotency_key=key, **data)
    db.add(expense)
    db.flush()
    db.add(models.AuditLog(shop_id=shop_id, action="expense.created", entity_id=expense.id, details=str(payload.amount)))
    db.commit()
    db.refresh(expense)
    return expense


def calculate_summary(db: Session, shop_id: str, start: datetime, end: datetime):
    sales = db.scalars(select(models.Sale).where(
        models.Sale.shop_id == shop_id, models.Sale.created_at >= start, models.Sale.created_at < end
    )).all()
    expenses = db.scalars(select(models.Expense).where(
        models.Expense.shop_id == shop_id, models.Expense.created_at >= start, models.Expense.created_at < end
    )).all()
    sale_ids = [sale.id for sale in sales]
    sale_items = db.scalars(select(models.SaleItem).where(models.SaleItem.sale_id.in_(sale_ids))).all() if sale_ids else []
    revenue = sum((sale.total for sale in sales), ZERO)
    cogs = sum((item.quantity * item.cost_price for item in sale_items), ZERO)
    expense_total = sum((expense.amount for expense in expenses), ZERO)
    return {
        "sales": revenue, "expenses": expense_total, "gross_profit": revenue - cogs,
        "net_operating_earnings": revenue - cogs - expense_total, "sale_count": len(sales),
    }


def date_window(days: int):
    today = date.today()
    start_day = today - timedelta(days=days - 1)
    start = datetime.combine(start_day, datetime.min.time(), timezone.utc)
    end = datetime.combine(today + timedelta(days=1), datetime.min.time(), timezone.utc)
    return start, end


def reorder_suggestions(db: Session, shop_id: str, buffer_days: int = 7):
    products = db.scalars(select(models.Product).where(
        models.Product.shop_id == shop_id, models.Product.is_archived.is_(False)
    )).all()
    since = datetime.now(timezone.utc) - timedelta(days=30)
    result = []
    for product in products:
        sold = db.scalar(
            select(func.sum(models.SaleItem.quantity))
            .join(models.Sale, models.Sale.id == models.SaleItem.sale_id)
            .where(models.Sale.shop_id == shop_id, models.SaleItem.product_id == product.id, models.Sale.created_at >= since)
        ) or ZERO
        daily = sold / Decimal("30")
        target = max(product.min_stock, daily * buffer_days)
        suggested = max(ZERO, (target - product.stock).quantize(Decimal("0.001")))
        if product.stock <= product.min_stock or suggested > 0:
            result.append({
                "product_id": product.id, "name": product.name, "stock": product.stock,
                "min_stock": product.min_stock, "average_daily_sales": daily.quantize(Decimal("0.01")),
                "suggested_quantity": suggested, "history_sufficient": sold > 0,
            })
    return sorted(result, key=lambda item: (item["stock"] > item["min_stock"], item["name"]))


def create_pending(
    db: Session, shop_id: str, action_type: str, payload: dict,
    idempotency_key: str | None = None, summary: str = "",
):
    key = idempotency_key or str(uuid.uuid4())
    serialized_payload = json.dumps(payload, sort_keys=True)
    existing = db.scalar(select(models.PendingAction).where(models.PendingAction.idempotency_key == key))
    if existing:
        if existing.shop_id != shop_id or existing.action_type != action_type:
            raise HTTPException(status_code=409, detail="This request key has already been used.")
        if existing.status != "pending":
            raise HTTPException(status_code=409, detail="This request has already been processed.")
        if existing.payload != serialized_payload or (summary and existing.summary != summary):
            raise HTTPException(status_code=409, detail="This request key is already awaiting confirmation for different details.")
        return existing
    active_action = db.scalar(select(models.PendingAction).where(
        models.PendingAction.shop_id == shop_id, models.PendingAction.status == "pending",
    ))
    if active_action:
        raise HTTPException(status_code=409, detail="A shop change is already awaiting confirmation. Confirm or cancel it first.")
    action = models.PendingAction(
        shop_id=shop_id, action_type=action_type, payload=serialized_payload,
        summary=summary, idempotency_key=key,
    )
    db.add(action)
    db.commit()
    db.refresh(action)
    return action


def execute_pending(db: Session, shop: models.Shop, action: models.PendingAction):
    if action.shop_id != shop.id:
        raise HTTPException(status_code=404, detail="Pending action not found in this shop.")
    if action.status != "pending":
        raise HTTPException(status_code=409, detail="This action has already been processed.")
    payload = json.loads(action.payload)
    if action.action_type == "create_supplier":
        args = SupplierCreate.model_validate(payload)
        if db.scalar(select(models.Supplier.id).where(
            models.Supplier.shop_id == shop.id, func.lower(models.Supplier.name) == args.name.lower(),
        )):
            raise HTTPException(status_code=409, detail="A supplier with this name already exists. Cancel this action and use the existing supplier.")
        supplier = models.Supplier(shop_id=shop.id, **args.model_dump())
        db.add(supplier)
        db.flush()
        db.add(models.AuditLog(shop_id=shop.id, action="supplier.created", entity_id=supplier.id))
        action.status = "completed"
        db.commit()
        return {"type": "supplier", "id": supplier.id, "name": supplier.name}
    if action.action_type == "create_sale":
        payload["idempotency_key"] = action.idempotency_key
        result, duplicate = create_sale(db, shop, SaleCreate.model_validate(payload))
        action.status = "completed"
        db.commit()
        return {"type": "sale", "id": result.id, "total": str(result.total), "duplicate": duplicate}
    if action.action_type == "record_customer_payment":
        balance, duplicate = record_customer_payment(
            db, shop.id, payload["customer_id"], Decimal(payload["amount"]), action.idempotency_key
        )
        action.status = "completed"
        db.commit()
        return {"type": "customer_payment", "balance": str(balance), "duplicate": duplicate}
    if action.action_type == "record_supplier_payment":
        supplier_id = payload["supplier_id"]
        amount = Decimal(payload["amount"])
        existing = db.scalar(select(models.SupplierLedger).where(
            models.SupplierLedger.idempotency_key == action.idempotency_key
        ))
        if existing:
            if existing.shop_id != shop.id or existing.supplier_id != supplier_id:
                raise HTTPException(status_code=409, detail="This request key has already been used.")
            action.status = "completed"
            db.commit()
            return {"type": "supplier_payment", "balance": str(supplier_balance(db, shop.id, supplier_id)), "duplicate": True}
        supplier = db.scalar(select(models.Supplier).where(
            models.Supplier.id == supplier_id, models.Supplier.shop_id == shop.id
        ))
        if not supplier:
            raise HTTPException(status_code=404, detail="Supplier not found.")
        balance = supplier_balance(db, shop.id, supplier_id)
        if amount <= 0 or amount > balance:
            raise HTTPException(status_code=409, detail=f"Payment must be positive and no more than ₹{balance}.")
        db.add(models.SupplierLedger(
            shop_id=shop.id, supplier_id=supplier_id, amount=amount.quantize(Decimal("0.01")),
            entry_type="payment", idempotency_key=action.idempotency_key,
        ))
        action.status = "completed"
        db.add(models.AuditLog(shop_id=shop.id, action="supplier.payment", entity_id=supplier_id, details=str(amount)))
        db.commit()
        return {"type": "supplier_payment", "balance": str(supplier_balance(db, shop.id, supplier_id)), "duplicate": False}
    if action.action_type == "record_purchase":
        payload["idempotency_key"] = action.idempotency_key
        result, duplicate = create_purchase(db, shop.id, PurchaseCreate.model_validate(payload))
        action.status = "completed"
        db.commit()
        return {"type": "purchase", "id": result.id, "total": str(result.total), "duplicate": duplicate}
    if action.action_type == "record_expense":
        payload["idempotency_key"] = action.idempotency_key
        result = record_expense(db, shop.id, ExpenseCreate.model_validate(payload))
        action.status = "completed"
        db.commit()
        return {"type": "expense", "id": result.id, "amount": str(result.amount)}
    raise HTTPException(status_code=400, detail="This action type is not supported.")
