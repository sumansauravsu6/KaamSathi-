import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Numeric, String, Text, UniqueConstraint, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def new_id() -> str:
    return str(uuid.uuid4())


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str | None] = mapped_column(String(255), unique=True, index=True, nullable=True)
    phone: Mapped[str | None] = mapped_column(String(16), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), unique=True)
    shop: Mapped["Shop"] = relationship(back_populates="user")


class Shop(Base):
    __tablename__ = "shops"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(160))
    address: Mapped[str] = mapped_column(String(300), default="")
    language: Mapped[str] = mapped_column(String(10), default="hi-IN")
    language_configured: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    allow_negative_stock: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    user: Mapped[User] = relationship(back_populates="shop", uselist=False)


class Product(Base):
    __tablename__ = "products"
    __table_args__ = (Index("ix_products_shop_name", "shop_id", "name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    category: Mapped[str] = mapped_column(String(100), default="General")
    sku: Mapped[str | None] = mapped_column(String(80), nullable=True)
    unit: Mapped[str] = mapped_column(String(30), default="pcs")
    purchase_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    selling_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    stock: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("0"))
    min_stock: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal("5"))
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Customer(Base):
    __tablename__ = "customers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    language: Mapped[str] = mapped_column(String(10), default="hi-IN")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Supplier(Base):
    __tablename__ = "suppliers"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Sale(Base):
    __tablename__ = "sales"
    __table_args__ = (Index("ix_sales_shop_created", "shop_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    customer_id: Mapped[str | None] = mapped_column(ForeignKey("customers.id"), nullable=True)
    payment_method: Mapped[str] = mapped_column(String(20))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    idempotency_key: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    items: Mapped[list["SaleItem"]] = relationship(cascade="all, delete-orphan")


class SaleItem(Base):
    __tablename__ = "sale_items"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    sale_id: Mapped[str] = mapped_column(ForeignKey("sales.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    cost_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))


class CustomerLedger(Base):
    __tablename__ = "customer_ledger_entries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    customer_id: Mapped[str] = mapped_column(ForeignKey("customers.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    entry_type: Mapped[str] = mapped_column(String(20))
    reference_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(120), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class InventoryMovement(Base):
    __tablename__ = "inventory_movements"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), index=True)
    quantity_delta: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    reason: Mapped[str] = mapped_column(String(40))
    reference_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Purchase(Base):
    __tablename__ = "purchases"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    supplier_id: Mapped[str] = mapped_column(ForeignKey("suppliers.id"))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    payment_method: Mapped[str] = mapped_column(String(20), default="credit")
    idempotency_key: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class PurchaseItem(Base):
    __tablename__ = "purchase_items"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    purchase_id: Mapped[str] = mapped_column(ForeignKey("purchases.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))


class SupplierLedger(Base):
    __tablename__ = "supplier_ledger_entries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    supplier_id: Mapped[str] = mapped_column(ForeignKey("suppliers.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    entry_type: Mapped[str] = mapped_column(String(20))
    reference_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(120), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Expense(Base):
    __tablename__ = "expenses"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    category: Mapped[str] = mapped_column(String(80))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    payment_method: Mapped[str] = mapped_column(String(20), default="cash")
    notes: Mapped[str] = mapped_column(Text, default="")
    idempotency_key: Mapped[str | None] = mapped_column(String(120), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class PendingAction(Base):
    __tablename__ = "pending_actions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    action_type: Mapped[str] = mapped_column(String(50))
    payload: Mapped[str] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="pending")
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    action: Mapped[str] = mapped_column(String(80))
    entity_id: Mapped[str] = mapped_column(String(36))
    details: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    language: Mapped[str] = mapped_column(String(10), default="hi-IN")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ShoppingSession(Base):
    __tablename__ = "shopping_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ShoppingOrder(Base):
    __tablename__ = "shopping_orders"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    shop_id: Mapped[str] = mapped_column(ForeignKey("shops.id"), index=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("shopping_sessions.id"), unique=True)
    status: Mapped[str] = mapped_column(String(40), default="draft", index=True)
    revision: Mapped[int] = mapped_column(default=0)
    reviewed_revision: Mapped[int | None] = mapped_column(nullable=True)
    checkout_confirmation_pending: Mapped[bool] = mapped_column(Boolean, default=False)
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    customer_name: Mapped[str] = mapped_column(String(100), default="Customer")
    notes: Mapped[str] = mapped_column(String(1000), default="")
    proposal_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    sale_id: Mapped[str | None] = mapped_column(ForeignKey("sales.id"), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ShoppingOrderItem(Base):
    __tablename__ = "shopping_order_items"
    __table_args__ = (UniqueConstraint("order_id", "product_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    order_id: Mapped[str] = mapped_column(ForeignKey("shopping_orders.id"), index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    unit: Mapped[str] = mapped_column(String(30))
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3))
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))


class ShoppingMessage(Base):
    __tablename__ = "shopping_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    order_id: Mapped[str] = mapped_column(ForeignKey("shopping_orders.id"), index=True)
    sender: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(String(1000))
    language: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ShoppingEvent(Base):
    __tablename__ = "shopping_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    order_id: Mapped[str] = mapped_column(ForeignKey("shopping_orders.id"), index=True)
    status: Mapped[str] = mapped_column(String(40))
    note: Mapped[str] = mapped_column(String(1000), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ShoppingTurn(Base):
    __tablename__ = "shopping_turns"
    __table_args__ = (UniqueConstraint("order_id", "request_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    order_id: Mapped[str] = mapped_column(ForeignKey("shopping_orders.id"), index=True)
    request_id: Mapped[str] = mapped_column(String(36))
    user_text: Mapped[str] = mapped_column(String(2000))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    response_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
