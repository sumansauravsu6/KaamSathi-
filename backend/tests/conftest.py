from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models
from app.db import Base


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = factory()
    shop = models.Shop(name="Test shop")
    session.add(shop)
    session.flush()
    session.info["shop"] = shop
    session.info["product"] = models.Product(
        shop_id=shop.id, name="Maggi", category="Snacks", unit="pack",
        purchase_price=Decimal("12"), selling_price=Decimal("15"),
        stock=Decimal("20"), min_stock=Decimal("5"),
    )
    session.add(session.info["product"])
    session.info["customer"] = models.Customer(shop_id=shop.id, name="Ravi")
    session.info["supplier"] = models.Supplier(shop_id=shop.id, name="Kumar Traders")
    session.add_all([session.info["customer"], session.info["supplier"]])
    session.commit()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()
