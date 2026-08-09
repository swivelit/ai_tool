declare module "react-native-razorpay" {
  type CheckoutOptions = { key: string; amount: number; currency: string; order_id: string; name?: string; description?: string; notes?: Record<string, string> };
  const RazorpayCheckout: { open(options: CheckoutOptions): Promise<{ razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }> };
  export default RazorpayCheckout;
}

