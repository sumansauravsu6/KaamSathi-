from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import models
from app.business import (
    calculate_summary, create_pending, create_product, create_purchase, create_sale,
    customer_balance, date_window, record_customer_payment, record_expense, reorder_suggestions,
    supplier_balance,
)
from app.schemas import ExpenseCreate, ProductCreate, PurchaseCreate, SaleCreate


def sale_payload(db, **kwargs):
    base = {
        "items": [{"product_id": db.info["product"].id, "quantity": Decimal("3")}],
        "payment_method": "cash", "idempotency_key": "test-sale-key-001",
    }
    return SaleCreate.model_validate({**base, **kwargs})


def test_create_product_persists_inventory(db):
    product = create_product(db, db.info["shop"].id, ProductCreate(
        name="Rice", category="Staples", unit="kg", purchase_price=Decimal("40"),
        selling_price=Decimal("50"), stock=Decimal("10"), min_stock=Decimal("2"),
    ))
    assert product.name == "Rice"
    assert product.stock == Decimal("10.000")
    assert db.scalar(select(models.InventoryMovement).where(models.InventoryMovement.product_id == product.id)).quantity_delta == Decimal("10")


def test_itemised_sale_deducts_stock_and_calculates_total(db):
    sale, duplicate = create_sale(db, db.info["shop"], sale_payload(db))
    assert sale.total == Decimal("45.00")
    assert not duplicate
    db.refresh(db.info["product"])
    assert db.info["product"].stock == Decimal("17.000")


def test_sale_rejects_insufficient_stock_without_partial_changes(db):
    with pytest.raises(HTTPException) as error:
        create_sale(db, db.info["shop"], sale_payload(db, items=[{
            "product_id": db.info["product"].id, "quantity": Decimal("21"),
        }]))
    assert error.value.status_code == 409
    db.refresh(db.info["product"])
    assert db.info["product"].stock == Decimal("20.000")
    assert db.scalars(select(models.Sale)).all() == []


def test_credit_sale_adds_customer_ledger_charge(db):
    sale, _ = create_sale(db, db.info["shop"], sale_payload(
        db, payment_method="credit", customer_id=db.info["customer"].id,
    ))
    assert sale.total == Decimal("45.00")
    assert customer_balance(db, db.info["shop"].id, db.info["customer"].id) == Decimal("45.00")


def test_partial_payment_reduces_balance_and_duplicate_does_not_repeat(db):
    create_sale(db, db.info["shop"], sale_payload(
        db, payment_method="credit", customer_id=db.info["customer"].id,
    ))
    balance, duplicate = record_customer_payment(
        db, db.info["shop"].id, db.info["customer"].id, Decimal("20"), "customer-pay-key-001",
    )
    assert balance == Decimal("25.00")
    assert not duplicate
    balance, duplicate = record_customer_payment(
        db, db.info["shop"].id, db.info["customer"].id, Decimal("20"), "customer-pay-key-001",
    )
    assert balance == Decimal("25.00")
    assert duplicate
    assert len(db.scalars(select(models.CustomerLedger)).all()) == 2


def test_purchase_increases_stock_and_records_supplier_balance(db):
    purchase, duplicate = create_purchase(db, db.info["shop"].id, PurchaseCreate(
        supplier_id=db.info["supplier"].id,
        items=[{"product_id": db.info["product"].id, "quantity": Decimal("10"), "unit_price": Decimal("11")}],
        payment_method="credit", idempotency_key="test-purchase-key-001",
    ))
    db.refresh(db.info["product"])
    assert not duplicate
    assert purchase.total == Decimal("110.00")
    assert db.info["product"].stock == Decimal("30.000")
    assert supplier_balance(db, db.info["shop"].id, db.info["supplier"].id) == Decimal("110.00")


def test_summary_uses_itemised_costs_and_excludes_supplier_purchases(db):
    create_sale(db, db.info["shop"], sale_payload(db))
    start, end = date_window(1)
    summary = calculate_summary(db, db.info["shop"].id, start, end)
    assert summary["sales"] == Decimal("45.00")
    assert summary["gross_profit"] == Decimal("9.000")
    record_expense(db, db.info["shop"].id, ExpenseCreate(category="Electricity", amount=Decimal("4")))
    summary = calculate_summary(db, db.info["shop"].id, start, end)
    assert summary["expenses"] == Decimal("4")
    assert summary["net_operating_earnings"] == Decimal("5.000")


def test_reorder_suggestion_is_transparent_without_sales_history(db):
    product = db.info["product"]
    product.stock = Decimal("2")
    db.commit()
    suggestion = next(item for item in reorder_suggestions(db, db.info["shop"].id) if item["product_id"] == product.id)
    assert suggestion["suggested_quantity"] == Decimal("3.000")
    assert suggestion["history_sufficient"] is False


def test_reorder_suggestion_uses_recent_sales_average(db):
    product = db.info["product"]
    product.stock = Decimal("0")
    sale = models.Sale(
        shop_id=db.info["shop"].id, payment_method="cash", total=Decimal("300"),
        idempotency_key="history-sale-key", created_at=datetime.now(timezone.utc) - timedelta(days=10),
    )
    db.add(sale)
    db.flush()
    db.add(models.SaleItem(
        sale_id=sale.id, product_id=product.id, quantity=Decimal("30"),
        unit_price=Decimal("15"), cost_price=Decimal("12"),
    ))
    db.commit()
    suggestion = next(item for item in reorder_suggestions(db, db.info["shop"].id) if item["product_id"] == product.id)
    assert suggestion["history_sufficient"] is True
    assert suggestion["average_daily_sales"] == Decimal("1.00")
    assert suggestion["suggested_quantity"] == Decimal("7.000")


def test_pending_action_cancellation_does_not_create_sale(db):
    action = create_pending(db, db.info["shop"].id, "create_sale", sale_payload(db).model_dump(mode="json"))
    action.status = "cancelled"
    db.commit()
    assert action.status == "cancelled"
    assert db.scalars(select(models.Sale)).all() == []
    assert db.info["product"].stock == Decimal("20.000")


def test_idempotent_sale_returns_original_transaction(db):
    sale, duplicate = create_sale(db, db.info["shop"], sale_payload(db))
    again, duplicate_again = create_sale(db, db.info["shop"], sale_payload(db))
    assert again.id == sale.id
    assert duplicate is False
    assert duplicate_again is True
    assert len(db.scalars(select(models.Sale)).all()) == 1


def test_records_are_scoped_to_their_shop(db):
    other_shop = models.Shop(name="Other shop")
    db.add(other_shop)
    db.flush()
    other_product = models.Product(
        shop_id=other_shop.id, name="Other product", unit="pcs",
        purchase_price=Decimal("1"), selling_price=Decimal("2"), stock=Decimal("5"), min_stock=Decimal("1"),
    )
    db.add(other_product)
    db.commit()
    with pytest.raises(HTTPException) as error:
        create_sale(db, db.info["shop"], sale_payload(db, items=[{
            "product_id": other_product.id, "quantity": Decimal("1"),
        }]))
    assert error.value.status_code == 404
    assert db.scalar(select(models.Product).where(
        models.Product.shop_id == db.info["shop"].id, models.Product.id == other_product.id
    )) is None


def test_expense_idempotency_prevents_double_recording(db):
    first = record_expense(db, db.info["shop"].id, ExpenseCreate(
        category="Power", amount=Decimal("25"), idempotency_key="expense-key-0001",
    ))
    second = record_expense(db, db.info["shop"].id, ExpenseCreate(
        category="Power", amount=Decimal("25"), idempotency_key="expense-key-0001",
    ))
    assert first.id == second.id
    assert len(db.scalars(select(models.Expense)).all()) == 1
