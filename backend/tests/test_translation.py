import asyncio
import json
import re
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import models, sarvam
from app.db import get_db
from app.main import app
from app.schemas import TranslationRequest
from app.security import current_user


def mock_translation(monkeypatch, handler):
    settings = SimpleNamespace(
        sarvam_api_key="test-key", sarvam_translate_model="mayura:v1",
        sarvam_api_base_url="https://api.sarvam.ai",
    )
    monkeypatch.setattr(sarvam, "get_settings", lambda: settings)
    monkeypatch.setattr(sarvam, "_client", lambda: httpx.AsyncClient(
        base_url=settings.sarvam_api_base_url,
        headers={"api-subscription-key": settings.sarvam_api_key},
        transport=httpx.MockTransport(handler),
    ))


def test_translation_restores_names_repeated_amounts_and_addresses(monkeypatch):
    def handler(request):
        body = json.loads(request.content)
        assert request.url.path == "/translate"
        assert request.headers["api-subscription-key"] == "test-key"
        assert body["source_language_code"] == "en-IN"
        assert body["target_language_code"] == "ta-IN"
        assert body["model"] == "mayura:v1"
        assert "Maggi" not in body["input"] and "45" not in body["input"]
        markers = re.findall(r"(?:PERSON|PRODUCT|ADDRESS|NUMBER)_[A-Z]+", body["input"])
        return httpx.Response(200, json={"translated_text": "தமிழ் " + " ".join(reversed(markers))})

    mock_translation(monkeypatch, handler)
    result = asyncio.run(sarvam.translate_text(
        "Ravi: 3 Maggi cost ₹45. Pay ₹45 at 12 Gandhi Road.",
        "en-IN", "ta-IN", {"Ravi": "PERSON", "Maggi": "PRODUCT", "12 Gandhi Road": "ADDRESS"},
    ))
    assert result["translated_text"] == "தமிழ் 12 Gandhi Road ₹45 ₹45 Maggi 3 Ravi"
    assert result["original_text"].startswith("Ravi:")


@pytest.mark.parametrize("response", [{"translated_text": "Missing protected terms"}, {"translated_text": ""}, []])
def test_unusable_or_unsafe_translation_is_not_returned_as_success(monkeypatch, response):
    mock_translation(monkeypatch, lambda _: httpx.Response(200, json=response))
    with pytest.raises(HTTPException) as error:
        asyncio.run(sarvam.translate_text("Maggi costs 45", "en-IN", "hi-IN", {"Maggi": "PRODUCT"}))
    assert error.value.status_code == 502


def test_many_protected_tokens_do_not_collide(monkeypatch):
    mock_translation(monkeypatch, lambda request: httpx.Response(
        200, json={"translated_text": json.loads(request.content)["input"]},
    ))
    terms = {"Brand" + chr(65 + number // 26) + chr(65 + number % 26): "PRODUCT" for number in range(30)}
    original = " ".join(terms)
    result = asyncio.run(sarvam.translate_text(original, "en-IN", "hi-IN", terms))
    assert result["translated_text"] == original


@pytest.mark.parametrize("translated", ["Pay 50 rupees", "Pay 1.2.3 rupees"])
def test_changed_amount_is_rejected(monkeypatch, translated):
    mock_translation(monkeypatch, lambda _: httpx.Response(200, json={"translated_text": translated}))
    with pytest.raises(HTTPException) as error:
        asyncio.run(sarvam.translate_text("Pay 45 rupees", "en-IN", "hi-IN", {}))
    assert error.value.status_code == 502


def test_duplicate_protected_marker_is_rejected(monkeypatch):
    mock_translation(monkeypatch, lambda request: httpx.Response(
        200, json={"translated_text": json.loads(request.content)["input"] + " PRODUCT_A"},
    ))
    with pytest.raises(HTTPException) as error:
        asyncio.run(sarvam.translate_text("Maggi", "en-IN", "hi-IN", {"Maggi": "PRODUCT"}))
    assert error.value.status_code == 502


@pytest.mark.parametrize("status", [401, 402, 429, 500])
def test_provider_failures_are_explicit(monkeypatch, status):
    mock_translation(monkeypatch, lambda _: httpx.Response(status, json={"error": "Provider error"}))
    with pytest.raises(HTTPException) as error:
        asyncio.run(sarvam.translate_text("Hello", "en-IN", "hi-IN", {}))
    assert error.value.status_code == 502


@pytest.mark.parametrize("changes", [
    {"text": "   "}, {"source_language": "xx-XX"},
    {"target_language": "en-IN"}, {"protected_terms": [""]},
    {"text": "a" * 1001},
])
def test_translation_arguments_are_validated(changes):
    with pytest.raises(ValueError):
        TranslationRequest.model_validate({
            "text": "Hello", "source_language": "en-IN", "target_language": "hi-IN", **changes,
        })


def test_translation_route_scopes_glossary_and_never_calls_business_tools(monkeypatch, db):
    other_shop = models.Shop(name="Other shop")
    db.add(other_shop)
    db.flush()
    db.add(models.Customer(shop_id=other_shop.id, name="Private customer"))
    db.commit()
    seen = {}

    async def translate(text, source, target, terms):
        seen["terms"] = terms
        return {"original_text": text, "translated_text": "अनुवाद", "source_language": source, "target_language": target}

    def forbidden(*args, **kwargs):
        pytest.fail("Translation must not execute business tools.")

    monkeypatch.setattr("app.main.translate_text", translate)
    monkeypatch.setattr(sarvam, "execute_tool", forbidden)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[current_user] = lambda: SimpleNamespace(shop_id=db.info["shop"].id, shop=db.info["shop"])
    try:
        response = TestClient(app).post("/api/translation", json={
            "text": "Record a sale of 3 Maggi to Ravi", "source_language": "en-IN", "target_language": "hi-IN",
            "protected_terms": ["Aashirvaad"],
        })
        assert response.status_code == 200
        assert {"Maggi", "Ravi", "Aashirvaad"}.issubset(seen["terms"])
        assert "Private customer" not in seen["terms"]
        assert db.query(models.Sale).count() == 0
        assert db.query(models.PendingAction).count() == 0
        assert db.info["product"].stock == 20
    finally:
        app.dependency_overrides.clear()


def test_translation_requires_authentication():
    response = TestClient(app).post("/api/translation", json={
        "text": "Hello", "source_language": "en-IN", "target_language": "hi-IN",
    })
    assert response.status_code in {401, 403}
