/**
 * RMS Finance API
 * Handles: Wallet, Transactions, Deposits, Withdrawals, Gift Codes, Target Growth, VIP Upgrades
 */

import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';
import { initiatePayment, initiateTransfer } from '../lib/targetgrowths.js';

export default async function handler(req, res) {
  const action = req.query.action || req.body?.action;
  
  try {
    switch (action) {
      // --- WALLET & TRANSACTIONS ---
      case 'getWallet': return await getWallet(req, res);
      case 'getTransactions': return await getTransactions(req, res);
      case 'getDeposits': return await getDeposits(req, res);
      case 'getWithdrawals': return await getWithdrawals(req, res);
      case 'getWithdrawalEligibility': return await getWithdrawalEligibility(req, res);
      case 'getDepositStatus': return await getDepositStatus(req, res);
      
      // --- MANUAL DEPOSIT/WITHDRAWAL ---
      case 'createDeposit': return await createDeposit(req, res);
      case 'createWithdrawal': return await createWithdrawal(req, res);
      
      // --- TARGET GROWTH ---
      case 'initiateTargetGrowthDeposit': return await initiateTargetGrowthDeposit(req, res);
      case 'initiateTargetGrowthWithdrawal': return await initiateTargetGrowthWithdrawal(req, res);
      
      // --- GIFT CODES ---
      case 'generateGiftCodes': return await generateGiftCodes(req, res);
      case 'getMyGiftCodes': return await getMyGiftCodes(req, res);
      case 'redeemGiftCode': return await redeemGiftCode(req, res);
      
      // --- VIP UPGRADES ---
      case 'upgradeVip': return await upgradeVip(req, res);
      
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Finance API Critical Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ==========================================
// HELPERS
// ==========================================

const TG_BANK_CODES = {
  'access bank': 'NGR044', 'access': 'NGR044',
  'guaranty trust bank': 'NGR058', 'gtbank': 'NGR058', 'gtb': 'NGR058',
  'zenith bank': 'NGR057', 'zenith': 'NGR057',
  'united bank for africa': 'NGR033', 'uba': 'NGR033',
  'first bank': 'NGR011', 'first bank of nigeria': 'NGR011',
  'fidelity bank': 'NGR070', 'fidelity': 'NGR070',
  'union bank': 'NGR032', 'union bank of nigeria': 'NGR032',
  'sterling bank': 'NGR232', 'sterling': 'NGR232',
  'wema bank': 'NGR035', 'wema': 'NGR035', 'tools by wema': 'NGR035A',
  'stanbic ibtc': 'NGR221', 'stanbic': 'NGR221',
  'ecobank': 'NGR050', 'ecobank nigeria': 'NGR050',
  'polaris bank': 'NGR076', 'polaris': 'NGR076',
  'opay': 'NGR20009', 'paycom': 'NGR999992',
  'palmpay': 'NGR999991', 'kuda': 'NGR50211', 'bank horse': 'NGR50211',
  'vfd': 'NGR566', 'vfd microfinance bank': 'NGR566',
  'moniepoint': 'NGR50515', 'sparkle': 'NGR51310'
};

function getTargetGrowthBankCode(bankName) {
  if (!bankName) return null;
  const cleanName = bankName.trim().toLowerCase();
  if (TG_BANK_CODES[cleanName]) return TG_BANK_CODES[cleanName];
  for (const [key, code] of Object.entries(TG_BANK_CODES)) {
    if (cleanName.includes(key)) return code;
  }
  return null;
}

function getAppUrl(req) {
  return "https://rms888.vercel.app";
}

function generateGiftCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GIFT-';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i === 3) code += '-';
  }
  return code;
}

// ==========================================
// WALLET & TRANSACTIONS
// ==========================================

async function getWallet(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('*').eq('user_id', user.id).single();
  if (!wallet) return res.status(200).json({ balance: 0, total_earned: 0, total_deposited: 0, total_withdrawn: 0 });
  return res.status(200).json(wallet);
}

async function getTransactions(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: transactions } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
    
  return res.status(200).json({ transactions: transactions || [] });
}

async function getDeposits(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: deposits } = await supabaseAdmin.from('deposits').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json({ deposits: deposits || [] });
}

async function getWithdrawals(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: withdrawals } = await supabaseAdmin.from('withdrawals').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  return res.status(200).json({ withdrawals: withdrawals || [] });
}

async function getWithdrawalEligibility(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await supabaseAdmin.from('profiles').select('vip_level').eq('id', user.id).single();
  const tier = profile?.vip_level || 'newbie';
  
  if (tier === 'newbie' || tier === 'M0') {
    return res.status(200).json({ can_withdraw_now: false, tier, reason_blocked: 'Upgrade to M1 or higher to withdraw.' });
  }

  // Check Weekly Schedule & Time (WAT Timezone UTC+1)
  const now = new Date();
  const watTime = new Date(now.getTime() + (60 * 60 * 1000));
  const watDay = watTime.getDay(); 
  const watHour = watTime.getHours();
  
  const dayMap = { 'M1': 1, 'M2': 1, 'M3': 2, 'M4': 2, 'M5': 3, 'M6': 4, 'M7': 5 };
  const allowedDay = dayMap[tier];
  
  if (allowedDay && watDay !== allowedDay) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return res.status(200).json({ can_withdraw_now: false, tier, reason_blocked: `Withdrawals for ${tier} are only available on ${dayNames[allowedDay]}. Today is ${dayNames[watDay]}.` });
  }

  if (watDay === 0 || watDay === 6) {
    return res.status(200).json({ can_withdraw_now: false, tier, reason_blocked: 'Withdrawals are closed on weekends.' });
  }

  if (watHour < 9 || watHour >= 18) {
    return res.status(200).json({ can_withdraw_now: false, tier, reason_blocked: 'Withdrawals are only available from 9am to 6pm WAT.' });
  }

  const watNow = new Date(now.getTime() + 60 * 60 * 1000);
  watNow.setUTCHours(0, 0, 0, 0);
  const watStart = new Date(watNow.getTime() - 60 * 60 * 1000);

  const { data: todayWithdrawals } = await supabaseAdmin
    .from('withdrawals')
    .select('id')
    .eq('user_id', user.id)
    .gte('created_at', watStart.toISOString());

  if (todayWithdrawals && todayWithdrawals.length > 0) {
    return res.status(200).json({ can_withdraw_now: false, tier, reason_blocked: 'You have already made a withdrawal today. Limit is 1 per day.' });
  }

  return res.status(200).json({ can_withdraw_now: true, tier });
}

async function getDepositStatus(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  
  const ref = req.query.ref;
  if (!ref) return res.status(400).json({ error: 'Reference required' });

  const { data: deposit } = await supabaseAdmin.from('deposits').select('status, amount, provider_status').eq('reference', ref).eq('user_id', user.id).single();
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
  return res.status(200).json(deposit);
}

// ==========================================
// MANUAL DEPOSIT & WITHDRAWAL
// ==========================================

async function createDeposit(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, payment_method, proof_image_url, sender_name } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const reference = `MAN_${user.id.slice(0, 8)}_${Date.now()}`;
  const { data: deposit, error } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id, amount: Number(amount), reference, sender_name, payment_method, proof_image_url, status: 'pending', method: 'manual', provider: 'manual'
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ message: 'Deposit submitted for approval.', deposit });
}

async function createWithdrawal(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, bank_name, account_number, account_name } = req.body;
  const { data: profile } = await supabaseAdmin.from('profiles').select('vip_level').eq('id', user.id).single();
  const tier = profile?.vip_level || 'newbie';
  
  if (tier === 'newbie' || tier === 'M0') return res.status(400).json({ error: 'Upgrade to M1 or higher to withdraw.' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet) return res.status(400).json({ error: 'Wallet not found.' });
  if (Number(amount) > wallet.balance) return res.status(400).json({ error: 'Insufficient available balance.' });

  const reference = `WD_${user.id.slice(0, 8)}_${Date.now()}`;
  const { data: wd, error: wdErr } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id, amount: Number(amount), net_amount: Number(amount), bank_name, account_number, account_name, status: 'pending', method: 'manual', provider: 'manual'
  }).select().single();
  
  if (wdErr) return res.status(500).json({ error: wdErr.message });

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'withdrawal', amount: Number(amount), status: 'pending', reference: `wd_${wd.id}`, description: `Withdrawal to ${account_name}`
  });

  return res.status(201).json({ message: 'Withdrawal request submitted.', withdrawal: wd });
}

// ==========================================
// TARGET GROWTH DEPOSIT
// ==========================================

async function initiateTargetGrowthDeposit(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, email, full_name } = req.body;
  const numAmount = Number(amount);
  
  // FIX 1: Minimum amount for Gateway 21 (Eazypay NGN) is 600
  if (!numAmount || numAmount < 600) {
    return res.status(400).json({ error: 'Minimum deposit is ₦600 for Target Growth' });
  }

  // FIX 2: Identifier MUST be max 20 characters
  // Format: TGD + 8 chars of user ID + 4 chars of timestamp = 15 chars (well under 20)
  const shortUserId = user.id.replace(/-/g, '').slice(0, 8);
  const shortTime = Date.now().toString(36).slice(-4).toUpperCase();
  const identifier = `TGD${shortUserId}${shortTime}`; // Max 15 chars
  
  const reference = `TG_DEP_${identifier}`;

  const { error: insertError } = await supabaseAdmin.from('deposits').insert({
    user_id: user.id, 
    amount: numAmount, 
    reference, 
    status: 'pending', 
    method: 'targetgrowths', 
    provider: 'targetgrowths', 
    provider_identifier: identifier, 
    provider_status: 'initiated', 
    created_at: new Date().toISOString()
  });
    
  if (insertError) return res.status(500).json({ error: insertError.message });

  try {
    const origin = getAppUrl(req);
    const ipnUrl = `${origin}/api/webhooks/targetgrowths`;
    
    // FIX 3: Truncate name and email to max 30 characters to satisfy Target Growth API
    const safeName = (full_name || 'RMS User').substring(0, 30).trim();
    const safeEmail = (email || 'user@example.com').substring(0, 30).trim();

    const providerResponse = await initiatePayment({
      identifier, 
      amount: numAmount, 
      details: `RMS Wallet Deposit`, 
      ipnUrl,
      successUrl: `${origin}/deposit-success.html?ref=${encodeURIComponent(reference)}`,
      cancelUrl: `${origin}/deposit.html?cancelled=true`,
      siteLogo: `${origin}/logo.png`, 
      customerName: safeName, 
      customerEmail: safeEmail
    });

    const checkoutUrl = providerResponse?.url || providerResponse?.checkout_url || providerResponse?.payment_url;
    const providerRef = providerResponse?.transaction_ref || providerResponse?.trx_id;

    if (!checkoutUrl) throw new Error('Target Growth did not return a checkout URL');

    await supabaseAdmin.from('deposits').update({
      provider_reference: providerRef, 
      provider_status: 'checkout_created', 
      provider_response: providerResponse, 
      updated_at: new Date().toISOString()
    }).eq('reference', reference);

    return res.status(200).json({ ok: true, reference, identifier, checkout_url: checkoutUrl });

  } catch (e) {
    console.error('[TG Deposit Initiate Error]', e);
    await supabaseAdmin.from('deposits').update({
      status: 'rejected', 
      provider_status: 'initiation_failed', 
      provider_error: e.message, 
      updated_at: new Date().toISOString()
    }).eq('reference', reference);
    
    return res.status(502).json({ error: e.message || 'Could not start payment' });
  }
}

// ==========================================
// TARGET GROWTH WITHDRAWAL
// ==========================================

async function initiateTargetGrowthWithdrawal(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { amount, bank_name, account_number, account_name } = req.body;
  const numAmount = Number(amount);

  const bankId = getTargetGrowthBankCode(bank_name);
  if (!bankId) return res.status(400).json({ error: `Bank "${bank_name}" is not supported for Target Growth payouts.` });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  if (!wallet) return res.status(400).json({ error: 'Wallet not found.' });
  if (numAmount > wallet.balance) return res.status(400).json({ error: 'Insufficient available balance.' });

  const reference = `TG_WD_${user.id.replace(/-/g, '').slice(0, 8)}_${Date.now()}`;
  
  const { data: wd, error: wdErr } = await supabaseAdmin.from('withdrawals').insert({
    user_id: user.id, amount: numAmount, net_amount: numAmount, bank_name, account_number, account_name, reference,
    status: 'pending', method: 'targetgrowths', provider: 'targetgrowths', provider_status: 'awaiting_admin_approval', created_at: new Date().toISOString()
  }).select().single();

  if (wdErr) return res.status(500).json({ error: wdErr.message });

  await supabaseAdmin.from('wallets').update({ balance: wallet.balance - numAmount, updated_at: new Date().toISOString() }).eq('user_id', user.id);

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id, type: 'withdrawal', amount: numAmount, status: 'pending', reference: `wd_${wd.id}`, description: `Pending Target Growth Withdrawal to ${account_name}`
  });

  return res.status(201).json({ ok: true, message: 'Withdrawal request submitted for admin approval.', withdrawal: wd });
}

// ==========================================
// VIP UPGRADES
// ==========================================

async function upgradeVip(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { tier, amount } = req.body;
  if (!tier || !amount) return res.status(400).json({ error: 'Missing tier or amount' });

  const { data: currentProfile } = await supabaseAdmin
    .from('profiles')
    .select('vip_level, referred_by')
    .eq('id', user.id)
    .single();

  const previousTier = currentProfile?.vip_level || 'newbie';
  const referrerId = currentProfile?.referred_by;

  const { data: wallet } = await supabaseAdmin
    .from('wallets')
    .select('balance')
    .eq('user_id', user.id)
    .single();

  if (!wallet) return res.status(400).json({ error: 'Wallet not found.' });
  if (Number(wallet.balance) < Number(amount)) {
    return res.status(400).json({ error: 'Insufficient balance for this upgrade.' });
  }

  await supabaseAdmin
    .from('wallets')
    .update({ balance: Number(wallet.balance) - Number(amount), updated_at: new Date().toISOString() })
    .eq('user_id', user.id);

  await supabaseAdmin
    .from('profiles')
    .update({ vip_level: tier })
    .eq('id', user.id);

  const tierOrder = ['newbie', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
  const prevIndex = tierOrder.indexOf(previousTier);
  const newIndex = tierOrder.indexOf(tier);

  if (newIndex >= 3 && prevIndex < 3 && referrerId) {
    const { data: referrerProfile } = await supabaseAdmin
      .from('profiles')
      .select('gift_code_generations_available')
      .eq('id', referrerId)
      .single();

    const currentGens = referrerProfile?.gift_code_generations_available || 0;
    
    await supabaseAdmin
      .from('profiles')
      .update({ gift_code_generations_available: currentGens + 1 })
      .eq('id', referrerId);
  }

  await supabaseAdmin.from('transactions').insert({
    user_id: user.id,
    type: 'vip_upgrade',
    amount: Number(amount),
    status: 'approved',
    reference: `vip_upgrade_${Date.now()}`,
    description: `VIP Upgrade to ${tier}`
  });

  return res.status(200).json({ ok: true, message: `Successfully upgraded to ${tier}!` });
}

// ==========================================
// GIFT CODES
// ==========================================

async function generateGiftCodes(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // 1. Check available generations
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('gift_code_generations_available')
      .eq('id', user.id)
      .single();
      
    const availableGenerations = profile?.gift_code_generations_available || 0;
    if (availableGenerations <= 0) {
      return res.status(400).json({ error: 'No generations available.' });
    }

    // 2. Fetch eligible M2+ referrals
    const { data: referrals, error: refError } = await supabaseAdmin
      .from('profiles')
      .select('id, vip_level, email, full_name')
      .eq('referred_by', user.id)
      .in('vip_level', ['M2', 'M3', 'M4', 'M5', 'M6', 'M7']);

    if (refError) {
      console.error('Error fetching referrals:', refError);
      return res.status(500).json({ error: 'Failed to fetch referrals' });
    }

    if (!referrals || referrals.length === 0) {
      return res.status(400).json({ error: 'No eligible M2+ referrals found' });
    }

    // 3. Generate codes
    const generatedCodes = [];
    for (const ref of referrals) {
      const randomAmount = Math.floor(Math.random() * 451) + 50; 
      const code = generateGiftCode();

      const percentages = { 'M2': '5%', 'M3': '8%', 'M4': '12%', 'M5': '15%', 'M6': '18%', 'M7': '20%' };
      const percentage = percentages[ref.vip_level] || '5%';

      const { error: insertError } = await supabaseAdmin.from('gift_codes').insert({
        code, 
        amount: randomAmount, 
        max_uses: 1, 
        used_count: 0, 
        is_active: true, 
        created_by: user.id, 
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (insertError) {
        console.error('Failed to insert gift code:', insertError);
        return res.status(500).json({ error: `Database error: ${insertError.message}` });
      }

      generatedCodes.push({ 
        code, 
        referral: ref.full_name || ref.email, 
        tier: ref.vip_level, 
        amount: randomAmount,
        percentage: percentage
      });
    }

    // 4. Decrement generations available
    await supabaseAdmin
      .from('profiles')
      .update({ gift_code_generations_available: availableGenerations - 1 })
      .eq('id', user.id);

    return res.status(200).json({ 
      success: true, 
      codes: generatedCodes, 
      remaining_generations: availableGenerations - 1 
    });

  } catch (err) {
    console.error('Generate Gift Codes Critical Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

async function getMyGiftCodes(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { data: codes } = await supabaseAdmin.from('gift_codes').select('*').eq('created_by', user.id).order('created_at', { ascending: false }).limit(20);
  return res.status(200).json({ codes: codes || [] });
}

async function redeemGiftCode(req, res) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const { data: giftCode, error: findError } = await supabaseAdmin.from('gift_codes').select('*').eq('code', code.toUpperCase().trim()).single();
  if (findError || !giftCode) return res.status(404).json({ error: 'Invalid gift code' });
  if (!giftCode.is_active) return res.status(400).json({ error: 'This gift code has already been used' });
  if (giftCode.expires_at && new Date(giftCode.expires_at) < new Date()) return res.status(400).json({ error: 'This gift code has expired' });
  //if (giftCode.created_by === user.id) return res.status(400).json({ error: 'You cannot redeem your own generated gift code' });

  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user.id).single();
  const newBalance = (wallet?.balance || 0) + Number(giftCode.amount);

  await supabaseAdmin.from('wallets').update({ balance: newBalance, updated_at: new Date() }).eq('user_id', user.id);
  await supabaseAdmin.from('gift_codes').update({ is_active: false, used_count: 1, used_by: user.id }).eq('id', giftCode.id);
  await supabaseAdmin.from('transactions').insert({ user_id: user.id, type: 'gift_code', amount: giftCode.amount, status: 'approved', reference: `gift_redeem_${Date.now()}`, description: `Redeemed Gift Code: ${code}` });

  return res.status(200).json({ success: true, amount: giftCode.amount, new_balance: newBalance, message: `Success! ₦${giftCode.amount.toLocaleString()} added to your wallet.` });
}
