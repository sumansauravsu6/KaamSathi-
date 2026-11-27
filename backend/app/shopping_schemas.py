from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.schemas import StrictSchema

Language = Literal["hi-IN", "en-IN", "ta-IN"]


class EmptyInput(StrictSchema):
    pass


class RevisionInput(StrictSchema):
    expected_revision: int = Field(ge=0, strict=True)


class CartItemInput(StrictSchema):
    product_id: str = Field(min_length=1, max_length=36)
    quantity: Decimal = Field(gt=0, le=999, max_digits=9, decimal_places=3, allow_inf_nan=False)


class CartInput(RevisionInput):
    items: list[CartItemInput] = Field(max_length=30)


class CartDetailsInput(RevisionInput):
    customer_name: str = Field(default="Customer", min_length=1, max_length=100)
    notes: str = Field(default="", max_length=1000)

    @field_validator("customer_name")
    @classmethod
    def name_not_blank(cls, value: str):
        if not value.strip():
            raise ValueError("Use a name or leave the name as Customer.")
        return value.strip()


class CheckoutInput(RevisionInput):
    confirmed: bool = Field(strict=True)

    @field_validator("confirmed")
    @classmethod
    def explicitly_confirmed(cls, value: bool):
        if not value:
            raise ValueError("Explicit confirmation is required to place an order.")
        return value


class StatusInput(RevisionInput):
    status: Literal["accepted", "rejected", "ready_for_collection", "completed", "cancelled"]
    note: str = Field(default="", max_length=1000)
    payment_method: Literal["cash", "upi"] | None = None


class SubstitutionInput(RevisionInput):
    product_id: str = Field(min_length=1, max_length=36)
    replacement_product_id: str = Field(min_length=1, max_length=36)
    quantity: Decimal = Field(gt=0, le=999, max_digits=9, decimal_places=3, allow_inf_nan=False)
    note: str = Field(default="", max_length=1000)


class SubstitutionDecision(RevisionInput):
    accept: bool = Field(strict=True)


class MessageInput(StrictSchema):
    text: str = Field(min_length=1, max_length=1000)
    language: Language

    @field_validator("text")
    @classmethod
    def text_not_blank(cls, value: str):
        if not value.strip():
            raise ValueError("Write a message before sending.")
        return value.strip()


class SpeakInput(StrictSchema):
    text: str = Field(min_length=1, max_length=1200)
    language: Language


class TranslateInput(StrictSchema):
    text: str = Field(min_length=1, max_length=1000)
    source_language: Language
    target_language: Language


class ShoppingAssistantInput(StrictSchema):
    message: str = Field(min_length=1, max_length=2000)
    language: Language
    request_id: UUID

    @field_validator("message")
    @classmethod
    def message_not_blank(cls, value: str):
        if not value.strip():
            raise ValueError("Speak or type a shopping request.")
        return value.strip()


class ProductQuery(StrictSchema):
    query: str = Field(min_length=1, max_length=160)


class ProductId(StrictSchema):
    product_id: str = Field(min_length=1, max_length=36)
