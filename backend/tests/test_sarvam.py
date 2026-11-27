import asyncio
import base64
import json
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace

import httpx
import pytest
from fastapi import UploadFile
from starlette.datastructures import Headers
from sqlalchemy import select

from app import models
from app import sarvam
from app.business import create_pending, customer_balance


def test_transcription_sends_multipart_audio_to_saaras(monkeypatch):
    seen = {}

    def handler(request):
        seen["request"] = request
        return httpx.Response(200, json={"transcript": "Ravi paid 300 rupees", "language_code": "en-IN", "language_probability": 0.94})

    settings = SimpleNamespace(
        sarvam_api_key="test-key", sarvam_stt_model="saaras:v4", sarvam_stt_mode="transcribe",
        sarvam_keyterms="Maggi,Ravi", sarvam_api_base_url="https://api.sarvam.ai",
    )
    monkeypatch.setattr(sarvam, "get_settings", lambda: settings)
    monkeypatch.setattr(sarvam, "_client", lambda: httpx.AsyncClient(
        base_url=settings.sarvam_api_base_url,
        headers={"api-subscription-key": settings.sarvam_api_key},
        transport=httpx.MockTransport(handler),
    ))
    upload = UploadFile(
        filename="shop-audio.webm", file=BytesIO(b"wave-bytes"),
        headers=Headers({"content-type": "audio/webm;codecs=opus"}),
    )
    result = asyncio.run(sarvam.transcribe(upload, mode="codemix"))
    sent = seen["request"]
    body = sent.content.decode("latin-1")
    assert sent.url.path == "/speech-to-text"
    assert sent.headers["api-subscription-key"] == "test-key"
    assert "saaras:v4" in body and "codemix" in body
    assert 'name="language_code"\r\n\r\nunknown' in body
    assert 'name="keyterms"\r\n\r\n["Maggi", "Ravi"]' in body
    assert "wave-bytes" in body
    assert "Content-Type: audio/webm\r\n" in body
    assert "codecs=opus" not in body
    assert result == {"transcript": "Ravi paid 300 rupees", "language_code": "en-IN", "request_id": None, "language_probability": 0.94}


@pytest.mark.parametrize("language", [None, "en-IN"])
def test_transcription_hints_preserve_names_and_respect_provider_limits(monkeypatch, language):
    seen = []

    def handler(request):
        body = request.content.decode("utf-8")
        keyterms = body.split('name="keyterms"\r\n\r\n', 1)[1].split("\r\n", 1)[0]
        seen.extend(json.loads(keyterms))
        assert f'name="language_code"\r\n\r\n{language or "unknown"}' in body
        return httpx.Response(200, json={"transcript": "Anmol Tea", "language_code": "en-IN"})

    settings = SimpleNamespace(sarvam_api_key="test-key", sarvam_stt_mode="transcribe",
                               sarvam_stt_model="saaras:v4", sarvam_keyterms="Maggi,Anmol Tea")
    monkeypatch.setattr(sarvam, "get_settings", lambda: settings)
    monkeypatch.setattr(sarvam, "_client", lambda: httpx.AsyncClient(
        base_url="https://api.sarvam.ai", transport=httpx.MockTransport(handler),
    ))
    result = asyncio.run(sarvam.transcribe(
        UploadFile(filename="voice.webm", file=BytesIO(b"audio")),
        language=language, keyterms=["Anmol Tea", "Anmol Tea", "x" * 65, ""] + [f"Product {i}" for i in range(60)],
    ))
    assert result["transcript"] == "Anmol Tea"
    assert len(seen) == 50 and seen[0] == "Anmol Tea"
    assert len(set(seen)) == 50 and all(0 < len(term) <= 64 for term in seen)


def test_tts_uses_configured_language_voice_and_model(monkeypatch):
    seen = {}
    audio = base64.b64encode(b"RIFF-test-audio").decode("ascii")

    def handler(request):
        seen["request"] = request
        return httpx.Response(200, json={"audios": [audio]})

    settings = SimpleNamespace(
        sarvam_api_key="test-key", sarvam_tts_model="bulbul:v4-flash",
        sarvam_tts_speakers='{"hi-IN":"ritu_hi_conversation","en-IN":"roopa_en_conversational","ta-IN":"gokul_ta_narration"}',
        sarvam_api_base_url="https://api.sarvam.ai",
    )
    monkeypatch.setattr(sarvam, "get_settings", lambda: settings)
    monkeypatch.setattr(sarvam, "_client", lambda: httpx.AsyncClient(
        base_url=settings.sarvam_api_base_url,
        headers={"api-subscription-key": settings.sarvam_api_key},
        transport=httpx.MockTransport(handler),
    ))
    result = asyncio.run(sarvam.speak("Namaste", "en-IN"))
    body = json.loads(seen["request"].content)
    assert seen["request"].url.path == "/text-to-speech"
    assert seen["request"].headers["api-subscription-key"] == "test-key"
    assert body["model"] == "bulbul:v4-flash"
    assert body["target_language_code"] == "en-IN"
    assert body["speaker"] == "roopa_en_conversational"
    assert result == b"RIFF-test-audio"


def test_assistant_calls_scoped_business_tool_then_returns_provider_response(monkeypatch, db):
    shop = db.info["shop"]
    product = db.info["product"]
    calls = []

    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            return httpx.Response(200, json={"choices": [{"message": {
                "role": "assistant", "content": None, "tool_calls": [{
                    "id": "call-search-1", "type": "function",
                    "function": {"name": "search_products", "arguments": '{"query":"Maggi"}'},
                }],
            }}]})
        tool_messages = [message for message in payload["messages"] if message.get("role") == "tool"]
        assert len(tool_messages) == 1
        assert product.id in tool_messages[0]["content"]
        return httpx.Response(200, json={"choices": [{"message": {
            "role": "assistant", "content": "Maggi has 20 packs in stock.",
        }}]})

    settings = SimpleNamespace(
        sarvam_api_key="test-key", sarvam_llm_model="sarvam-105b",
        sarvam_api_base_url="https://api.sarvam.ai",
    )
    monkeypatch.setattr(sarvam, "get_settings", lambda: settings)
    monkeypatch.setattr(sarvam, "_llm_client", lambda: httpx.AsyncClient(
        base_url=settings.sarvam_api_base_url,
        headers={"api-subscription-key": settings.sarvam_api_key},
        transport=httpx.MockTransport(handler),
    ))
    result = asyncio.run(sarvam.assistant_reply(db, shop, "How much Maggi is left?", "en-IN", None))
    assert result["text"] == "Maggi has 20 packs in stock."
    assert result["pending_action"] is None
    assert result["destination"] == "Inventory"
    assert calls[0]["tools"]
    assert calls[0]["tools"][0]["function"]["name"] == "search_products"
    assert db.scalar(select(models.Conversation).where(models.Conversation.id == result["conversation_id"]))


def test_voice_followup_can_correct_then_confirm_a_pending_payment(monkeypatch, db):
    shop = db.info["shop"]
    customer = db.info["customer"]
    db.add(models.CustomerLedger(
        shop_id=shop.id, customer_id=customer.id, amount=Decimal("100"),
        entry_type="charge",
    ))
    db.commit()
    action = create_pending(db, shop.id, "record_customer_payment", {
        "customer_id": customer.id, "amount": "30",
    }, summary="Record ₹30.00 payment from Ravi.")
    monkeypatch.setattr(sarvam, "get_settings", lambda: SimpleNamespace(sarvam_api_key="test-key"))

    corrected = asyncio.run(sarvam.assistant_reply(
        db, shop, "Actually, make it 50", "en-IN", None,
    ))
    assert corrected["pending_action"]["action_id"] == action.id
    assert corrected["pending_action"]["summary"] == "Record ₹50.00 payment from Ravi."
    assert customer_balance(db, shop.id, customer.id) == Decimal("100.00")

    confirmed = asyncio.run(sarvam.assistant_reply(
        db, shop, "Yes", "en-IN", corrected["conversation_id"],
    ))
    assert confirmed["pending_action"] is None
    assert confirmed["text"] == "Payment recorded. The new balance is ₹50.00."
    assert customer_balance(db, shop.id, customer.id) == Decimal("50.00")


def test_negative_voice_followup_cancels_without_ledger_write(monkeypatch, db):
    shop = db.info["shop"]
    customer = db.info["customer"]
    db.add(models.CustomerLedger(
        shop_id=shop.id, customer_id=customer.id, amount=Decimal("75"),
        entry_type="charge",
    ))
    db.commit()
    action = create_pending(db, shop.id, "record_customer_payment", {
        "customer_id": customer.id, "amount": "25",
    }, summary="Record ₹25.00 payment from Ravi.")
    monkeypatch.setattr(sarvam, "get_settings", lambda: SimpleNamespace(sarvam_api_key="test-key"))

    cancelled = asyncio.run(sarvam.assistant_reply(db, shop, "No", "en-IN", None))
    db.refresh(action)
    assert action.status == "cancelled"
    assert cancelled["pending_action"] is None
    assert cancelled["text"] == "Cancelled. Nothing was changed."
    assert customer_balance(db, shop.id, customer.id) == Decimal("75.00")
