import re
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")


def normalize_phone(value: str) -> str:
    compact = re.sub(r"[\s()-]", "", value)
    if compact.startswith("+91"):
        compact = compact[3:]
    elif compact.startswith("91") and len(compact) == 12:
        compact = compact[2:]
    if not re.fullmatch(r"[6-9][0-9]{9}", compact):
        raise ValueError("Use a valid 10-digit Indian mobile number, optionally prefixed with +91.")
    return "+91" + compact


class RegisterRequest(StrictSchema):
    email: str | None = Field(default=None, max_length=255)
    phone: str | None = None
    password: str = Field(min_length=8, max_length=72)
    shop_name: str = Field(min_length=1, max_length=160)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Use a valid email address.")
        return value

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, value: str | None) -> str | None:
        return normalize_phone(value) if value is not None else None

    @field_validator("shop_name")
    @classmethod
    def valid_shop_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Shop name cannot be empty.")
        return value.strip()

    @field_validator("password")
    @classmethod
    def valid_password(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must use at most 72 UTF-8 bytes.")
        return value

    @model_validator(mode="after")
    def one_identifier(self):
        if bool(self.email) == bool(self.phone):
            raise ValueError("Provide either an email address or a mobile number.")
        return self


class LoginRequest(StrictSchema):
    email: str | None = Field(default=None, max_length=255)
    identifier: str | None = Field(default=None, min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=72)

    @model_validator(mode="after")
    def one_identifier(self):
        if bool(self.email) == bool(self.identifier):
            raise ValueError("Provide one email address or mobile number.")
        if len(self.password.encode("utf-8")) > 72:
            raise ValueError("Password must use at most 72 UTF-8 bytes.")
        return self


class ShopUpdate(StrictSchema):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    address: str | None = Field(default=None, max_length=300)
    language: Literal["hi-IN", "en-IN", "ta-IN"] | None = None


class ProductCreate(StrictSchema):
    name: str = Field(min_length=1, max_length=160)
    category: str = "General"
    sku: str | None = None
    unit: str = "pcs"
    purchase_price: Decimal = Field(ge=0)
    selling_price: Decimal = Field(ge=0)
    stock: Decimal = Field(default=Decimal("0"), ge=0)
    min_stock: Decimal = Field(default=Decimal("5"), ge=0)


class ProductUpdate(StrictSchema):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    category: str | None = None
    purchase_price: Decimal | None = Field(default=None, ge=0)
    selling_price: Decimal | None = Field(default=None, ge=0)
    stock: Decimal | None = Field(default=None, ge=0)
    min_stock: Decimal | None = Field(default=None, ge=0)


class CustomerCreate(StrictSchema):
    name: str = Field(min_length=1, max_length=160)
    phone: str | None = None


class SupplierCreate(StrictSchema):
    name: str = Field(min_length=1, max_length=160)
    phone: str | None = Field(default=None, max_length=30)

    @field_validator("name")
    @classmethod
    def nonempty_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Supplier name cannot be empty.")
        return value.strip()


class SaleItemInput(StrictSchema):
    product_id: str
    quantity: Decimal = Field(gt=0)
    unit_price: Decimal | None = Field(default=None, ge=0)


class SaleCreate(StrictSchema):
    items: list[SaleItemInput] = Field(min_length=1)
    payment_method: str = Field(pattern="^(cash|upi|credit)$")
    customer_id: str | None = None
    idempotency_key: str = Field(min_length=8, max_length=120)


class PaymentCreate(StrictSchema):
    amount: Decimal = Field(gt=0)
    idempotency_key: str = Field(min_length=8, max_length=120)


class PurchaseItemInput(StrictSchema):
    product_id: str
    quantity: Decimal = Field(gt=0)
    unit_price: Decimal = Field(ge=0)


class PurchaseCreate(StrictSchema):
    supplier_id: str
    items: list[PurchaseItemInput] = Field(min_length=1)
    payment_method: str = Field(default="credit", pattern="^(cash|upi|credit)$")
    idempotency_key: str = Field(min_length=8, max_length=120)


class ExpenseCreate(StrictSchema):
    category: str = Field(min_length=1, max_length=80)
    amount: Decimal = Field(gt=0)
    payment_method: str = "cash"
    notes: str = ""
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=120)


class AssistantRequest(StrictSchema):
    message: str = Field(min_length=1, max_length=4000)
    language: str | None = None
    conversation_id: str | None = None


class ConfirmationRequest(StrictSchema):
    action_id: str
    confirmed: bool


class TranslationRequest(StrictSchema):
    text: str = Field(min_length=1, max_length=1000)
    source_language: Literal["auto", "hi-IN", "en-IN", "ta-IN"]
    target_language: Literal["hi-IN", "en-IN", "ta-IN"]
    detected_language: Literal["hi-IN", "en-IN", "ta-IN"] | None = None
    language_probability: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    protected_terms: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("text")
    @classmethod
    def nonempty_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text to translate cannot be empty.")
        return value.strip()

    @field_validator("protected_terms")
    @classmethod
    def validate_terms(cls, values: list[str]) -> list[str]:
        if any(not value.strip() or len(value) > 160 for value in values):
            raise ValueError("Protected terms must contain 1 to 160 characters.")
        return list(dict.fromkeys(value.strip() for value in values))

    @model_validator(mode="after")
    def different_languages(self):
        if self.source_language == self.target_language:
            raise ValueError("Choose different languages for the two speakers.")
        return self


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
