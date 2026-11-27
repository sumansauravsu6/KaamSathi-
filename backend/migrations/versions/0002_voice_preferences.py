"""Persist language onboarding and optional mobile login without losing existing shops."""
from alembic import op
import sqlalchemy as sa

revision = "0002_voice_preferences"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    shop_columns = {column["name"] for column in inspector.get_columns("shops")}
    if "language_configured" not in shop_columns:
        op.add_column("shops", sa.Column("language_configured", sa.Boolean(), nullable=False, server_default=sa.false()))
    user_columns = {column["name"]: column for column in inspector.get_columns("users")}
    # The initial migration creates metadata directly, so fresh databases already contain these fields.
    if "phone" not in user_columns or not user_columns["email"]["nullable"]:
        with op.batch_alter_table("users") as batch:
            if "phone" not in user_columns:
                batch.add_column(sa.Column("phone", sa.String(16), nullable=True))
                batch.create_unique_constraint("uq_users_phone", ["phone"])
            if not user_columns["email"]["nullable"]:
                batch.alter_column("email", existing_type=sa.String(255), nullable=True)


def downgrade():
    bind = op.get_bind()
    if bind.execute(sa.text("SELECT COUNT(*) FROM users WHERE email IS NULL")).scalar():
        raise RuntimeError("Cannot downgrade while mobile-only accounts exist. Add email addresses first.")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("phone")
        batch.alter_column("email", existing_type=sa.String(255), nullable=False)
    op.drop_column("shops", "language_configured")
