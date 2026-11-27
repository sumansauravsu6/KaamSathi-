from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User

passwords = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer(auto_error=False)


def create_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": user.id, "shop_id": user.shop_id, "iat": now, "exp": now + timedelta(days=7)},
        get_settings().jwt_secret_key,
        algorithm="HS256",
    )


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Please sign in to access your shop.")
    try:
        claims = jwt.decode(credentials.credentials, get_settings().jwt_secret_key, algorithms=["HS256"])
        user = db.get(User, claims.get("sub"))
        if user is None or user.shop_id != claims.get("shop_id"):
            raise HTTPException(status_code=401, detail="Your session is no longer valid. Please sign in again.")
        return user
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="Your session is invalid or has expired.") from exc


def hash_password(password: str) -> str:
    return passwords.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return passwords.verify(password, password_hash)
