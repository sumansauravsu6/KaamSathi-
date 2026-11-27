"""Add customer shopping sessions, carts, orders and accessible communication."""
from alembic import op

from app import models

revision = "0003_accessible_shopping"
down_revision = "0002_voice_preferences"
branch_labels = None
depends_on = None

TABLES = (
    models.ShoppingSession, models.ShoppingOrder, models.ShoppingOrderItem,
    models.ShoppingMessage, models.ShoppingEvent, models.ShoppingTurn,
)


def upgrade():
    for model in TABLES:
        model.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    for model in reversed(TABLES):
        model.__table__.drop(bind=op.get_bind(), checkfirst=True)
