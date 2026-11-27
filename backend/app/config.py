from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    sarvam_api_key: str = ""
    sarvam_stt_model: str = "saaras:v4"
    sarvam_stt_mode: str = "transcribe"
    sarvam_tts_model: str = "bulbul:v4-flash"
    sarvam_llm_model: str = "sarvam-105b"
    sarvam_translate_model: str = "sarvam-translate:v1"
    sarvam_api_base_url: str = "https://api.sarvam.ai"
    sarvam_tts_speakers: str = '{"hi-IN":"ritu_hi_conversation","en-IN":"roopa_en_conversational","ta-IN":"gokul_ta_narration"}'
    sarvam_keyterms: str = "Maggi,milk,bread,rice,sugar,atta,sunflower oil,biscuits,soap,shampoo,toothpaste"
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    database_url: str = "sqlite:///./kaamsaathi.db"
    jwt_secret_key: str = "replace-this-with-a-long-random-secret"
    app_env: str = "development"
    frontend_origin: str = "http://localhost:3000"
    public_shop_base_url: str = ""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
