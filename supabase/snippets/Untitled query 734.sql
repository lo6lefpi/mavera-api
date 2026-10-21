select email, paid_at, completed_at, rejected_at, rejection_reason, refund_status, stripe_subscription_id
from public.checkout_attempts
order by created_at desc
limit 5;