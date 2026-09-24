import supabaseAdmin from '../lib/supabase.js';
import { verifyUser } from '../lib/auth.js';

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    // Public endpoint (used by deposit page to show bank details)
    if (action === 'get-settings') return await getSettings(req, res);

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const { data: profile } = await supabaseAdmin.from('profiles').select('is_admin').eq('id', user.id).single();
    if (!profile?.is_admin) return res.status(403).json({ error: 'Admin access required' });

    switch (action) {
      case 'get-dashboard-stats': return await getDashboardStats(req, res);
      case 'get-deposits': return await getDeposits(req, res);
      case 'process-deposit': return await processDeposit(req, res);
      case 'get-withdrawals': return await getWithdrawals(req, res);
      case 'process-withdrawal': return await processWithdrawal(req, res);
      case 'get-users': return await getUsers(req, res);
      case 'update-user': return await updateUser(req, res);
      case 'adjust-balance': return await adjustBalance(req, res);
      case 'save-setting': return await saveSetting(req, res);
      case 'save-support-links': return await saveSupportLinks(req, res);
      case 'save-deposit-bank': return await saveDepositBank(req, res);
      case 'update-tier': return await updateTier(req, res);
      case 'admin-generate-gift-code': return await adminGenerateGiftCode(req, res);
      case 'send-message': return await sendMessage(req, res);
      case 'get-wealth-packages': return await getWealthPackages(req, res);
      case 'create-wealth-package': return await createWealthPackage(req, res);
      case 'update-wealth-package': return await updateWealthPackage(req, res);
      case 'delete-wealth-package': return await deleteWealthPackage(req, res);
      default: return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Admin API Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ==========================================
// DASHBOARD STATISTICS
// ==========================================
async function getDashboardStats(req, res) {
  const [usersResult, depositsResult, pendingDepositsResult, withdrawalsResult, pendingWithdrawalsResult] = await Promise.all([
    supabaseAdmin.from('profiles').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('deposits').select('amount').eq('status', 'completed'),
    supabaseAdmin.from('deposits').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabaseAdmin.from('withdrawals').select('amount, net_amount').eq('status', 'approved'),
    supabaseAdmin.from('withdrawals').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  ]);

  const errors = [
    usersResult.error, depositsResult.error, pendingDepositsResult.error,
    withdrawalsResult.error, pendingWithdrawalsResult.error
  ].filter(Boolean);

  if (errors.length) {
    console.error('[ADMIN] Dashboard statistics query errors:', errors);
    return res.status(500).json({ error: 'Failed to load dashboard statistics' });
  }

  const totalDeposits = (depositsResult.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalWithdrawals = (withdrawalsResult.data || []).reduce((sum, row) => sum + Number(row.net_amount ?? row.amount ?? 0), 0);

  return res.status(200).json({
    users: usersResult.count || 0,
    totalDeposits,
    pendingDeposits: pendingDepositsResult.count || 0,
    totalWithdrawals,
    pendingWithdrawals: pendingWithdrawalsResult.count || 0
  });
}

// ==========================================
// DEPOSITS (MANUAL FLOW)
// ==========================================
async function getDeposits(req, res) {
  const status = req.query.status || 'pending';
  let q = supabaseAdmin.from('deposits').select('*, profiles!user_id(full_name, email)').order('created_at', { ascending: false }).limit(100);
  if (status !== 'all') q = q.eq('status', status);
  const { data } = await q;
  return res.json({ ok: true, deposits: data || [] });
}

async function processDeposit(req, res) {
  const { deposit_id, act, note } = req.body;

  const { data: d } = await supabaseAdmin.from('deposits').select('*').eq('id', deposit_id).single();
  if (!d) return res.status(404).json({ error: 'Deposit not found' });
  if (d.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (act === 'reject') {
    await supabaseAdmin.from('deposits').update({
      status: 'rejected',
      provider_status: 'rejected_by_admin',
      note: note || 'Rejected by admin',
      updated_at: new Date().toISOString()
    }).eq('id', d.id);
    return res.json({ ok: true, action: 'rejected' });
  }

  if (act === 'approve') {
    // 1. Credit user's wallet
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', d.user_id).single();
    const newBalance = Number(wallet?.balance || 0) + Number(d.amount);
    await supabaseAdmin.from('wallets').upsert({
      user_id: d.user_id,
      balance: newBalance,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    // 2. Record transaction
    await supabaseAdmin.from('transactions').insert({
      user_id: d.user_id,
      type: 'deposit',
      amount: Number(d.amount),
      status: 'approved',
      reference: `DEPOSIT_${d.id}`,
      description: `Manual Deposit (${d.sender_name || 'User'})`,
      created_at: new Date().toISOString()
    });

    // 3. Pay 10% referral commission if referrer exists
    const { data: prof } = await supabaseAdmin.from('profiles').select('referred_by').eq('id', d.user_id).single();
    if (prof?.referred_by && prof.referred_by !== d.user_id) {
      const commission = Math.round(Number(d.amount) * 0.10 * 100) / 100;
      const { data: rw } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', prof.referred_by).single();
      await supabaseAdmin.from('wallets').upsert({
        user_id: prof.referred_by,
        balance: Number(rw?.balance || 0) + commission,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      await supabaseAdmin.from('referral_commissions').insert({
        referrer_id: prof.referred_by,
        referred_user_id: d.user_id,
        deposit_id: d.id,
        commission_amount: commission,
        status: 'paid',
        created_at: new Date().toISOString()
      });
    }

    // 4. Mark deposit completed
    await supabaseAdmin.from('deposits').update({
      status: 'completed',
      provider_status: 'approved_by_admin',
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', d.id);

    return res.json({ ok: true, action: 'approved', credited: Number(d.amount) });
  }

  return res.status(400).json({ error: 'Invalid action' });
}

// ==========================================
// WITHDRAWALS (MANUAL FLOW)
// ==========================================
async function getWithdrawals(req, res) {
  const status = req.query.status || 'pending';
  let q = supabaseAdmin.from('withdrawals').select('*, profiles!user_id(full_name, email)').order('created_at', { ascending: false }).limit(100);
  if (status !== 'all') q = q.eq('status', status);
  const { data } = await q;
  return res.json({ ok: true, withdrawals: data || [] });
}

async function processWithdrawal(req, res) {
  const { withdrawal_id, act, note } = req.body;

  const { data: w } = await supabaseAdmin.from('withdrawals').select('*').eq('id', withdrawal_id).single();
  if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
  if (w.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  if (act === 'reject') {
    // Refund user balance
    const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', w.user_id).single();
    const newBalance = Number(wallet?.balance || 0) + Number(w.amount);
    await supabaseAdmin.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', w.user_id);
    await supabaseAdmin.from('withdrawals').update({ status: 'rejected', note: note || 'Rejected by admin', processed_at: new Date().toISOString() }).eq('id', w.id);
    await supabaseAdmin.from('transactions').update({ status: 'rejected' }).eq('reference', `wd_${w.id}`);
    return res.json({ ok: true, action: 'rejected' });
  }

  if (act === 'approve') {
    // Manual approval - admin pays from their own bank
    await supabaseAdmin.from('withdrawals').update({
      status: 'approved',
      note: note || 'Approved by admin - manual payment',
      processed_at: new Date().toISOString()
    }).eq('id', w.id);
    await supabaseAdmin.from('transactions').update({ status: 'approved' }).eq('reference', `wd_${w.id}`);
    return res.json({ ok: true, action: 'approved', message: 'Withdrawal approved. Process payment manually.' });
  }

  return res.status(400).json({ error: 'Invalid action' });
}

// ==========================================
// USERS
// ==========================================
async function getUsers(req, res) {
  const search = (req.query.search || '').trim();
  let q = supabaseAdmin.from('profiles')
    .select('id, email, full_name, vip_level, is_frozen, created_at, wallets!left(balance)')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (search) q = q.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
  const { data } = await q;
  return res.json({ ok: true, users: data || [] });
}

async function updateUser(req, res) {
  const { user_id, vip_level, is_frozen } = req.body;
  const updates = {};
  if (vip_level !== undefined) updates.vip_level = vip_level;
  if (is_frozen !== undefined) updates.is_frozen = is_frozen;
  const { error } = await supabaseAdmin.from('profiles').update(updates).eq('id', user_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

async function adjustBalance(req, res) {
  const { user_id, amount, type, reason } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const { data: wallet } = await supabaseAdmin.from('wallets').select('balance').eq('user_id', user_id).single();
  if (!wallet) return res.status(400).json({ error: 'User wallet not found' });
  let newBalance = wallet.balance;
  if (type === 'credit') newBalance += numAmount;
  else if (type === 'debit') {
    if (wallet.balance < numAmount) return res.status(400).json({ error: 'Insufficient balance for debit' });
    newBalance -= numAmount;
  } else return res.status(400).json({ error: 'Invalid type' });
  await supabaseAdmin.from('wallets').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', user_id);
  await supabaseAdmin.from('transactions').insert({
    user_id, type: type === 'credit' ? 'admin_credit' : 'admin_debit', amount: numAmount,
    status: 'approved', reference: `admin_adj_${Date.now()}`, description: `Admin ${type}: ${reason || 'Manual adjustment'}`
  });
  return res.json({ ok: true, new_balance: newBalance });
}

// ==========================================
// VIP TIERS
// ==========================================
async function updateTier(req, res) {
  const { tier, upgrade_cost, daily_boxes, daily_earning } = req.body;
  const { error } = await supabaseAdmin.from('rms_tiers').update({
    upgrade_cost: Number(upgrade_cost), daily_boxes: Number(daily_boxes), daily_earning: Number(daily_earning)
  }).eq('tier', tier);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ==========================================
// GIFT CODES
// ==========================================
async function adminGenerateGiftCode(req, res) {
  const { amount, max_uses, expires_in_days } = req.body;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'ADMIN-';
  for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + Number(expires_in_days || 30));
  const { error } = await supabaseAdmin.from('gift_codes').insert({
    code,
    amount: Number(amount),
    max_uses: Number(max_uses),
    used_count: 0,
    is_active: true,
    created_by: null,
    expires_at: expiresAt.toISOString()
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, code });
}

// ==========================================
// MESSAGES
// ==========================================
async function sendMessage(req, res) {
  const { user_id, title, body } = req.body;
  const { error } = await supabaseAdmin.from('messages').insert({ user_id, title, body, is_read: false, created_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ==========================================
// WEALTH PACKAGES
// ==========================================
async function getWealthPackages(req, res) {
  const { data } = await supabaseAdmin.from('wealth_packages').select('*').order('investment_amount', { ascending: true });
  return res.json({ ok: true, packages: data || [] });
}

async function createWealthPackage(req, res) {
  const { name, investment_amount, daily_return, duration_days, total_return, start_date, end_date } = req.body;
  if (!name || !investment_amount || !daily_return || !duration_days || !total_return) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const { data, error } = await supabaseAdmin.from('wealth_packages').insert({
    name,
    investment_amount: Number(investment_amount),
    daily_return: Number(daily_return),
    duration_days: Number(duration_days),
    total_return: Number(total_return),
    start_date: start_date || null,
    end_date: end_date || null,
    is_active: true
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, package: data });
}

async function updateWealthPackage(req, res) {
  const { id, name, investment_amount, daily_return, duration_days, total_return, is_active, start_date, end_date } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (investment_amount !== undefined) updates.investment_amount = Number(investment_amount);
  if (daily_return !== undefined) updates.daily_return = Number(daily_return);
  if (duration_days !== undefined) updates.duration_days = Number(duration_days);
  if (total_return !== undefined) updates.total_return = Number(total_return);
  if (is_active !== undefined) updates.is_active = is_active;
  if (start_date !== undefined) updates.start_date = start_date || null;
  if (end_date !== undefined) updates.end_date = end_date || null;
  const { error } = await supabaseAdmin.from('wealth_packages').update(updates).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

async function deleteWealthPackage(req, res) {
  const { id } = req.body;
  const { error } = await supabaseAdmin.from('wealth_packages').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}

// ==========================================
// SETTINGS
// ==========================================
async function getSettings(req, res) {
  const { data } = await supabaseAdmin.from('site_settings').select('key, value');
  const settings = {};
  (data || []).forEach(row => { settings[row.key] = row.value; });
  return res.json({ ok: true, settings });
}

async function saveSetting(req, res) {
  const { key, value } = req.body;
  await supabaseAdmin.from('site_settings').upsert({ key, value: String(value) });
  return res.json({ ok: true });
}

async function saveSupportLinks(req, res) {
  const { telegram, whatsapp, support, withdrawal_fee_percentage } = req.body;
  if (telegram) await supabaseAdmin.from('site_settings').upsert({ key: 'telegram_link', value: telegram });
  if (whatsapp) await supabaseAdmin.from('site_settings').upsert({ key: 'whatsapp_link', value: whatsapp });
  if (support) await supabaseAdmin.from('site_settings').upsert({ key: 'support_link', value: support });
  if (withdrawal_fee_percentage !== undefined) await supabaseAdmin.from('site_settings').upsert({ key: 'withdrawal_fee_percentage', value: String(withdrawal_fee_percentage) });
  return res.json({ ok: true });
}

async function saveDepositBank(req, res) {
  const { bank_name, account_number, account_name } = req.body;
  if (bank_name) await supabaseAdmin.from('site_settings').upsert({ key: 'deposit_bank_name', value: bank_name });
  if (account_number) await supabaseAdmin.from('site_settings').upsert({ key: 'deposit_account_number', value: account_number });
  if (account_name) await supabaseAdmin.from('site_settings').upsert({ key: 'deposit_account_name', value: account_name });
  return res.json({ ok: true });
}
