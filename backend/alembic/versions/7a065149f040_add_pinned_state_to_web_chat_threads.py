"""add pinned state to web chat threads

Revision ID: 7a065149f040
Revises: c7e4a1b9d2f6
Create Date: 2026-09-08 12:52:24.335456

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7a065149f040'
down_revision: Union[str, Sequence[str], None] = 'c7e4a1b9d2f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    with op.batch_alter_table("web_chat_thread") as batch:
        batch.add_column(
            sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch.create_index("ix_web_chat_thread_pinned", ["pinned"])


def downgrade() -> None:
    with op.batch_alter_table("web_chat_thread") as batch:
        batch.drop_index("ix_web_chat_thread_pinned")
        batch.drop_column("pinned")