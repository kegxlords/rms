/**
 * TargetGrowths Webhook Handler
 * Trusts webhook payload directly - gateway controls when webhooks are sent
 * Includes fallback processing if RPC fails.
 */

import supabaseAdmin from '../../lib/supabase.js';
import { 
  parseWebhookBody, 
  webhookStatus, 
  webhookIdentifier, 
  webhookAmount, 
  isSuccessfulStatus, 
  isFailedStatus
} from '../../lib/targetgrowths.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = parseWebhookBody(req.body);
    console.log('[TG-WEBHOOK-RECEIVED]', payload);

    // FIX: Check root status first. If root says 'success', trust it.
    // Target Growth sometimes sends root: "success" but data.payment_status: "initiated"
    let status = webhookStatus(payload);
    if (payload?.status && isSuccessfulStatus(payload.status)) {
      console.log('[TG-WEBHOOK] Root status is success, overriding nested status:', status, '-> success');
      status = 'success';
    }

    const identifier = webhookIdentifier(payload);
    const amount = webhookAmount(payload);

    console.log('[TG-WEBHOOK] Final Status:', status, '| Identifier:', identifier, '| Amount:', amount);

    // 1. FIND THE DEPOSIT RECORD FIRST
    const { data: deposit, error: depositError } = await supabaseAdmin
      .from('deposits')
      .select('id, user_id, amount, status, reference')
      .eq('provider_identifier', identifier)
      .single();

    if (depositError || !deposit) {
      console.error('[TG-WEBHOOK] Deposit not found for identifier:', identifier);
      return res.status(404).json({ error: 'Deposit not found' });
    }

    // Idempotency: Skip if already completed
    if (deposit.status === 'completed') {
      console.log('[TG-WEBHOOK] Already processed, skipping duplicate');
      return res.status(200).json({ message: 'Already processed' });
    }

    // 2. HANDLE BASED ON WEBHOOK STATUS (Trust the gateway)
    if (isSuccessfulStatus(status)) {
      console.log('[TG-WEBHOOK] ✅ Payment successful, crediting user');

      // Verify amount matches (basic safety check)
      if (Number(amount) !== Number(deposit.amount)) {
        console.error(`[TG-WEBHOOK] ⚠️ Amount mismatch! Expected: ${deposit.amount}, Got: ${amount}`);
        await supabaseAdmin.from('deposits').update({
          status: 'rejected',
          provider_status: 'amount_mismatch',
          provider_response: payload,
          updated_at: new Date().toISOString()
        }).eq('id', deposit.id);
        return res.status(400).json({ error: 'Amount mismatch' });
      }

      // Try the atomic RPC function first
      const { data: completion, error: completionError } = await supabaseAdmin.rpc('complete_deposit_and_pay_referral', {
        p_deposit_id: deposit.id,
        p_provider_status: 'success',
        p_provider_response: payload,
        p_identifier: identifier
      });

      if (completionError) {
        console.error('[TG-WEBHOOK] ❌ RPC failed, falling back to manual processing:', completionError);
        
        // FALLBACK: Manually credit wallet and mark as completed
        const { data: wallet } = await supabaseAdmin
          .from('wallets')
          .select('balance')
          .eq('user_id', deposit.user_id)
          .single();

        const newBalance = (wallet?.balance || 0) + Number(deposit.amount);
        
        await supabaseAdmin.from('wallets').upsert({
          user_id: deposit.user_id,
          balance: newBalance,
          updated_at: new Date().toISOString()
        });

        await supabaseAdmin.from('transactions').insert({
          user_id: deposit.user_id,
          type: 'deposit',
          amount: Number(deposit.amount),
          status: 'approved',
          reference: `TG_DEPOSIT_${deposit.id}`,
          description: `Target Growth Deposit (${identifier})`,
          created_at: new Date().toISOString()
        });

        await supabaseAdmin.from('deposits').update({
          status: 'completed',
          provider_status: 'success',
          provider_response: payload,
          paid_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).eq('id', deposit.id);

        console.log('[TG-WEBHOOK] ✅ Manual fallback processing completed successfully');
        
        return res.status(200).json({
          success: true,
          message: 'Deposit completed (manual fallback)',
          amount: deposit.amount
        });
      }

      // RPC succeeded
      const result = Array.isArray(completion) ? completion[0] : completion;

      if (!result?.applied) {
        console.log('[TG-WEBHOOK] Duplicate completion ignored:', deposit.id);
        return res.status(200).json({ message: 'Already processed' });
      }

      console.log('[TG-WEBHOOK] ✅ Deposit completed atomically:', {
        depositId: deposit.id,
        creditedAmount: result.credited_amount,
        referralAmount: result.referral_amount,
        referrerId: result.referrer_id,
        newStatus: result.deposit_status
      });

      return res.status(200).json({
        success: true,
        referral_amount: result.referral_amount,
        referrer_id: result.referrer_id
      });

    } else if (isFailedStatus(status)) {
      // Payment failed
      console.log('[TG-WEBHOOK] ❌ Payment failed:', status);
      
      await supabaseAdmin.from('deposits').update({
        status: 'rejected',
        provider_status: status,
        provider_response: payload,
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id);
      
      return res.status(200).json({ message: 'Payment failed' });
      
    } else {
      // Pending/Initiated - just log it
      console.log('[TG-WEBHOOK] ⏳ Payment status:', status, '- waiting for confirmation');
      
      await supabaseAdmin.from('deposits').update({
        status: 'pending',
        provider_status: status,
        provider_response: payload,
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id);
      
      // Return 200 OK so gateway doesn't show error
      return res.status(200).json({ message: 'Payment pending' });
    }

  } catch (err) {
    console.error('[TG-WEBHOOK] Critical Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==========================================
// DEPOSIT HANDLER (PAYIN) - Kept for reference/legacy
// ==========================================
async function handleDeposit(identifier, amount, status, payload) {
  console.log(`[TG-DEPOSIT] Processing: ${identifier} | Status: ${status} | Amount: ${amount}`);

  const { data: deposit, error: findError } = await supabaseAdmin
    .from('deposits')
    .select('*')
    .eq('provider_identifier', identifier)
    .single();

  if (findError || !deposit) {
    console.error('[TG-DEPOSIT] ❌ Record not found for identifier:', identifier);
    return;
  }

  if (deposit.status === 'completed' || deposit.status === 'rejected') {
    console.log('[TG-DEPOSIT] ⏭️ Already processed. Skipping.');
    return;
  }

  if (isSuccessfulStatus(status)) {
    if (Number(amount) !== Number(deposit.amount)) {
      console.error(`[TG-DEPOSIT] ⚠️ Amount mismatch! Expected: ${deposit.amount}, Got: ${amount}`);
      await supabaseAdmin.from('deposits').update({
        status: 'pending',
        provider_status: 'amount_mismatch',
        provider_response: payload,
        updated_at: new Date().toISOString()
      }).eq('id', deposit.id);
      return;
    }

    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', deposit.user_id)
      .single();

    const newBalance = Number(wallet?.balance || 0) + Number(amount);

    await supabaseAdmin
      .from('wallets')
      .upsert({
        user_id: deposit.user_id,
        balance: newBalance,
        updated_at: new Date().toISOString()
      });

    console.log(`[TG-DEPOSIT] ✅ Wallet updated: ${wallet?.balance} → ${newBalance}`);

    await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: deposit.user_id,
        type: 'deposit',
        amount: Number(amount),
        status: 'approved',
        reference: deposit.reference,
        description: `Target Growth Deposit (${identifier})`
      });

    await supabaseAdmin
      .from('deposits')
      .update({
        status: 'completed',
        provider_status: 'success',
        provider_response: payload,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', deposit.id);

    console.log(`[TG-DEPOSIT] ✅ Successfully credited ₦${amount} to user ${deposit.user_id}`);
  } else if (isFailedStatus(status)) {
    await supabaseAdmin.from('deposits').update({
      status: 'rejected',
      provider_status: 'failed',
      provider_response: payload,
      updated_at: new Date().toISOString()
    }).eq('id', deposit.id);

    console.log(`[TG-DEPOSIT] ❌ Deposit failed for ${identifier}`);
  }
}

// ==========================================
// WITHDRAWAL HANDLER (PAYOUT) - Kept for reference/legacy
// ==========================================
async function handleWithdrawal(identifier, amount, status, payload) {
  console.log(`[TG-WITHDRAWAL] Processing: ${identifier} | Status: ${status} | Amount: ${amount}`);

  const { data: withdrawal, error: findError } = await supabaseAdmin
    .from('withdrawals')
    .select('*')
    .eq('provider_identifier', identifier)
    .single();

  if (findError || !withdrawal) {
    console.error('[TG-WITHDRAWAL] ❌ Record not found for identifier:', identifier);
    return;
  }

  if (withdrawal.status === 'completed' || withdrawal.status === 'failed') {
    console.log('[TG-WITHDRAWAL] ⏭️ Already processed. Skipping.');
    return;
  }

  if (isSuccessfulStatus(status)) {
    await supabaseAdmin.from('withdrawals').update({
      status: 'completed',
      provider_status: 'success',
      provider_response: payload,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', withdrawal.id);

    console.log(`[TG-WITHDRAWAL] ✅ Payout successful for ${identifier}`);
  } else if (isFailedStatus(status)) {
    const { data: wallet } = await supabaseAdmin
      .from('wallets')
      .select('balance')
      .eq('user_id', withdrawal.user_id)
      .single();

    const refundAmount = Number(amount);
    const newBalance = Number(wallet?.balance || 0) + refundAmount;

    await supabaseAdmin.from('wallets').upsert({
      user_id: withdrawal.user_id,
      balance: newBalance,
      updated_at: new Date().toISOString()
    });

    await supabaseAdmin.from('transactions').insert({
      user_id: withdrawal.user_id,
      type: 'withdrawal_refund',
      amount: refundAmount,
      status: 'approved',
      reference: `REF_${withdrawal.reference}`,
      description: `Target Growth Payout Failed - Refund (${identifier})`
    });

    await supabaseAdmin.from('withdrawals').update({
      status: 'failed',
      provider_status: 'failed',
      provider_response: payload,
      updated_at: new Date().toISOString()
    }).eq('id', withdrawal.id);

    console.log(`[TG-WITHDRAWAL] ❌ Payout failed. Refunded ₦${refundAmount} to user ${withdrawal.user_id}`);
  }
}
