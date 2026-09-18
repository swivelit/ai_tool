"""Website video metadata, reservations and outboxes; never media blobs."""
from alembic import op
import sqlalchemy as sa

revision = "20260918_website_video"
down_revision = "20260917_cli_cloud_artifacts"
branch_labels = None
depends_on = None


def s(name, length=64, nullable=False):
    return sa.Column(name, sa.String(length), nullable=nullable)


def dt(name, nullable=True):
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade():
    with op.batch_alter_table("payment_order") as batch:
        batch.drop_constraint("ck_payment_order_purchase_type", type_="check")
        batch.alter_column("credit_bucket", existing_type=sa.String(16), nullable=True)
        batch.create_check_constraint("ck_payment_order_purchase_type", "purchase_type IN ('topup', 'subscription', 'video_template')")
        batch.create_check_constraint("ck_payment_order_video_product", "(purchase_type = 'video_template' AND credit_bucket IS NULL AND gross_amount_paise = 2500 AND credited_amount_micros = 0 AND platform_share_paise = 0) OR (purchase_type <> 'video_template' AND credit_bucket IS NOT NULL)")
    op.create_table("video_control", sa.Column("id", sa.Integer(), primary_key=True), dt("maintenance_until"), dt("worker_seen_at"),
                    s("worker_boot"), sa.Column("capabilities_json", sa.Text(), nullable=False))
    op.execute(sa.text("INSERT INTO video_control (id,worker_boot,capabilities_json) VALUES (1,'','{}')"))
    op.create_table("video_template", s("id",32), s("title",80), s("manifest_hash"), sa.Column("metadata_json",sa.Text(),nullable=False), dt("published_at",False), sa.PrimaryKeyConstraint("id"))
    op.create_table("video_quota", s("id",36), sa.Column("user_id",sa.Integer(),sa.ForeignKey("user.id"),nullable=False), s("day",10),
                    sa.Column("used",sa.Integer(),nullable=False), sa.PrimaryKeyConstraint("id"),
                    sa.UniqueConstraint("user_id","day",name="uq_video_quota_day"),sa.CheckConstraint("used >= 0",name="ck_video_quota_nonnegative"))
    op.create_index("ix_video_quota_user_id","video_quota",["user_id"])
    op.create_table("video_job", s("id",36),sa.Column("user_id",sa.Integer(),sa.ForeignKey("user.id"),nullable=False),
                    s("request_key",80),s("request_hash"),s("email",320),sa.Column("template_id",sa.String(32),sa.ForeignKey("video_template.id"),nullable=False),
                    s("manifest_hash"),*[sa.Column(x,sa.Text(),nullable=False) for x in ("frozen_json","inputs_json","options_json")],
                    s("state",32),s("funding",16),sa.Column("quota_id",sa.String(36),sa.ForeignKey("video_quota.id")),s("quota_state",16),
                    sa.Column("payment_id",sa.String(36),sa.ForeignKey("payment_order.id"),unique=True),
                    sa.Column("thread_id",sa.String(36),sa.ForeignKey("web_chat_thread.id",ondelete="SET NULL")),
                    dt("created_at",False),dt("deadline",False),*[dt(x) for x in ("admitted_at","started_at","ready_at","expires_at","lease_until")],
                    s("fence"),sa.Column("attempt",sa.Integer(),nullable=False),sa.Column("progress",sa.Integer(),nullable=False),
                    s("phase",32),s("error",80),s("output_hash"),sa.Column("output_size",sa.Integer(),nullable=False),sa.PrimaryKeyConstraint("id"),
                    sa.UniqueConstraint("user_id","request_key",name="uq_video_request"))
    for key in ("user_id","state","created_at"):
        op.create_index("ix_video_job_"+key,"video_job",[key])
    op.create_table("video_outbox",s("id",36),sa.Column("job_id",sa.String(36),sa.ForeignKey("video_job.id"),nullable=False),
                    s("kind",16),s("state",32),sa.Column("attempts",sa.Integer(),nullable=False),dt("due_at",False),s("provider_id",80),s("error",80),
                    sa.PrimaryKeyConstraint("id"),sa.UniqueConstraint("job_id","kind",name="uq_video_outbox_event"))
    op.create_index("ix_video_outbox_job_id","video_outbox",["job_id"])


def downgrade():
    bind = op.get_bind()
    if bind.execute(sa.text("SELECT COUNT(*) FROM video_job")).scalar() or bind.execute(sa.text("SELECT COUNT(*) FROM payment_order WHERE purchase_type='video_template'")).scalar():
        raise RuntimeError("Refusing to drop financial video history; roll back code/flags instead")
    for table in ("video_outbox", "video_job", "video_quota", "video_template", "video_control"):
        op.drop_table(table)
    with op.batch_alter_table("payment_order") as batch:
        batch.drop_constraint("ck_payment_order_video_product", type_="check")
        batch.drop_constraint("ck_payment_order_purchase_type", type_="check")
        batch.create_check_constraint("ck_payment_order_purchase_type", "purchase_type IN ('topup', 'subscription')")
        batch.alter_column("credit_bucket", existing_type=sa.String(16), nullable=False)
