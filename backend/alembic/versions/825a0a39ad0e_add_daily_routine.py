from alembic import op
import sqlalchemy as sa

revision = "xxxx_add_daily_routine"
down_revision = "7ef80e265358"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table(
        "daily_routine",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("user.id"), nullable=False, unique=True),
        sa.Column("wake_time", sa.String, nullable=False),
        sa.Column("sleep_time", sa.String, nullable=False),
        sa.Column("work_start", sa.String),
        sa.Column("work_end", sa.String),
        sa.Column("daily_habits", sa.String),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )

def downgrade():
    op.drop_table("daily_routine")
