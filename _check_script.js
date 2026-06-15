
const API = 'https://rideapp-backend-production-5e1c.up.railway.app';

// ── Helpers ────────────────────────────────────────────
function fmt(d){return d?new Date(d).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'-'}
function rupee(n){return '₹'+parseFloat(n||0).toFixed(0)}
function trunc(s,n=25){return s&&s.length>n?s.slice(0,n)+'…':s||'-'}

function showSection(id,btn){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  if(id==='customers') loadCustomers();
  if(id==='drivers') loadDrivers();
  if(id==='rides') loadRides();
  if(id==='topups') loadTopups();
  if(id==='verify') loadVerifications();
  if(id==='settings') loadFares();
  if(id==='marketing'){loadCampaigns();loadPromos();loadReferrals();}
}

function openImg(src,label){
  document.getElementById('modal-img-el').src=src;
  document.getElementById('modal-img-label').textContent=label;
  document.getElementById('img-modal').classList.add('open');
}
function closeModal(){document.getElementById('img-modal').classList.remove('open')}
function closeDrvModal(){document.getElementById('drv-modal').classList.remove('open')}
function closeUsrModal(){document.getElementById('usr-modal').classList.remove('open')}

// ── Dashboard ───────────────────────────────────────────
async function loadDashboard(){
  console.log('[Admin] loadDashboard called');
  try{
    const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),10000);
    const r=await fetch(API+'/api/admin/dashboard',{signal:ctrl.signal});
    console.log('[Admin] dashboard response status:',r.status);
    const d=await r.json();
    document.getElementById('stats-grid').innerHTML=`
      <div class="stat-card red"><div class="stat-icon">👥</div><div class="stat-value">${d.customers}</div><div class="stat-label">Total Customers</div></div>
      <div class="stat-card"><div class="stat-icon">🚗</div><div class="stat-value">${d.drivers.total}</div><div class="stat-label">Drivers · ${d.drivers.online} online</div></div>
      <div class="stat-card blue"><div class="stat-icon">🛺</div><div class="stat-value">${d.rides.completed}</div><div class="stat-label">Completed Rides</div></div>
      <div class="stat-card green"><div class="stat-icon">💰</div><div class="stat-value">${rupee(d.rides.gross_revenue)}</div><div class="stat-label">Gross Revenue</div></div>
      <div class="stat-card red"><div class="stat-icon">🏦</div><div class="stat-value">${rupee(d.platform_commission)}</div><div class="stat-label">Platform Commission</div></div>
      <div class="stat-card"><div class="stat-icon">⏱️</div><div class="stat-value">${d.hourly.completed}</div><div class="stat-label">Hourly · ${rupee(d.hourly.revenue)}</div></div>
      <div class="stat-card blue"><div class="stat-icon">💳</div><div class="stat-value">${rupee(d.topup_total)}</div><div class="stat-label">Total Topups</div></div>
      <div class="stat-card"><div class="stat-icon">👛</div><div class="stat-value">${rupee(d.wallets.customer_total)}</div><div class="stat-label">Customer Wallets</div></div>
      <div class="stat-card green"><div class="stat-icon">🏧</div><div class="stat-value">${rupee(d.wallets.driver_total)}</div><div class="stat-label">Driver Wallets</div></div>
    `;
  }catch(e){document.getElementById('stats-grid').innerHTML='<div class="loading">❌ Dashboard load failed</div>';}
}

// ── Transactions ────────────────────────────────────────
async function loadTransactions(){
  try{
    const d=await fetch(API+'/api/admin/all-transactions?limit=200').then(r=>r.json());
    document.getElementById('txn-body').innerHTML=(d.transactions||[]).map(t=>`<tr>
      <td>${fmt(t.created_at)}</td><td>${t.name||'-'}</td><td>${t.phone}</td>
      <td><span class="badge-${t.type}">${t.type.toUpperCase()}</span></td>
      <td class="${t.type==='credit'?'amount-green':'amount-red'}">${rupee(t.amount)}</td>
      <td title="${t.description}">${trunc(t.description,40)}</td>
    </tr>`).join('');
  }catch(e){console.error('[Admin] loadTransactions failed:',e);}
}

// ── Rides ───────────────────────────────────────────────
async function loadRides(){
  try{
    const d=await fetch(API+'/api/admin/rides').then(r=>r.json());
    const rideStatusColor={completed:'#2e7d32',cancelled:'#c62828',active:'#1565c0',accepted:'#e65100',pending:'#888'};
    document.getElementById('rides-body').innerHTML=d.rides.map(r=>`<tr>
      <td>${fmt(r.created_at)}</td>
      <td>${r.passenger_name||'-'}<br><span style="color:#999;font-size:10px">${r.passenger_phone||''}</span></td>
      <td>${r.driver_name||'—'}</td>
      <td title="${r.pickup}">${trunc(r.pickup,20)}</td>
      <td title="${r.drop_location}">${trunc(r.drop_location,20)}</td>
      <td class="amount-green">${rupee(r.fare)}</td>
      <td><span style="font-size:10px;background:#f0f0f0;padding:2px 6px;border-radius:6px">${r.ride_type||'std'}</span></td>
      <td><span style="color:${rideStatusColor[r.status]||'#888'};font-weight:700;font-size:11px">${r.status}</span></td>
      <td>${r.rating?'⭐'.repeat(r.rating):'-'}</td>
    </tr>`).join('');
  }catch(e){document.getElementById('rides-body').innerHTML='<tr><td colspan=9 class=loading>❌ Load failed</td></tr>';}
}

// ── Customers ───────────────────────────────────────────
async function loadCustomers(){
  try{
    const d=await fetch(API+'/api/admin/users').then(r=>r.json());
    document.getElementById('cust-body').innerHTML=d.users.map(u=>`<tr>
      <td><b>${u.name||'-'}</b>${u.is_blocked?'<span style="color:#c62828;font-size:10px"> 🚫BLOCKED</span>':u.is_suspended?'<span style="color:#e65100;font-size:10px"> ⏸SUSPENDED</span>':''}</td>
      <td>${u.phone}</td>
      <td>${u.total_rides||0}</td>
      <td class="amount-green">${rupee(u.total_fare)}</td>
      <td class="amount-green">${rupee(u.wallet_balance)}</td>
      <td>${u.trust_score!=null?u.trust_score+'/100':'-'}${u.is_flagged?'<span style="color:#c62828"> ⚑</span>':''}</td>
      <td style="font-size:10px">${fmt(u.created_at)}</td>
      <td>
        <button class="action-btn btn-blue" onclick="openUserModal('${u.phone}',${JSON.stringify(u.name||'')},${!!u.is_blocked},${!!u.is_suspended})">Manage</button>
      </td>
    </tr>`).join('');
  }catch(e){document.getElementById('cust-body').innerHTML='<tr><td colspan=8 class=loading>❌ Load failed</td></tr>';}
}

function openUserModal(phone,name,isBlocked,isSuspended){
  const m=document.getElementById('usr-modal');
  document.getElementById('usr-modal-content').innerHTML=`
    <h3 style="margin-bottom:14px;font-size:15px">👤 User: ${name} (${phone})</h3>

    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600">📨 Send Message</div>
      <textarea id="usr-msg" placeholder="User ko message likhein..." class="input-sm" style="resize:none;height:60px;margin-bottom:6px"></textarea>
      <button class="action-btn btn-blue" style="width:100%;padding:8px" onclick="sendUserMessage('${phone}')">Send Message</button>
      <div id="usr-msg-status" style="font-size:11px;margin-top:4px"></div>
    </div>

    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600">⏸ Suspend User</div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input id="usr-suspend-hrs" type="number" placeholder="Hours (empty = permanent)" class="input-sm">
        <input id="usr-suspend-reason" placeholder="Reason" class="input-sm">
      </div>
      <div style="display:flex;gap:6px">
        <button class="action-btn btn-orange" style="flex:1;padding:8px" onclick="suspendUser('${phone}')">⏸ Suspend</button>
        ${isSuspended?`<button class="action-btn btn-green" style="flex:1;padding:8px" onclick="unsuspendUser('${phone}')">▶️ Unsuspend</button>`:''}
      </div>
      <div id="usr-suspend-status" style="font-size:11px;margin-top:4px"></div>
    </div>

    <div>
      <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600">🚫 Block User</div>
      <input id="usr-block-reason" placeholder="Block reason" class="input-sm" style="margin-bottom:6px">
      <div style="display:flex;gap:6px">
        <button class="action-btn btn-red" style="flex:1;padding:8px" onclick="blockUser('${phone}')">🚫 Block</button>
        ${isBlocked?`<button class="action-btn btn-green" style="flex:1;padding:8px" onclick="unblockUser('${phone}')">✅ Unblock</button>`:''}
      </div>
      <div id="usr-block-status" style="font-size:11px;margin-top:4px"></div>
    </div>
  `;
  m.classList.add('open');
}
async function sendUserMessage(phone){
  const msg=document.getElementById('usr-msg').value.trim();
  if(!msg){document.getElementById('usr-msg-status').textContent='❌ Message likhein';return;}
  const d=await fetch(API+'/api/admin/users/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,message:msg})}).then(r=>r.json());
  document.getElementById('usr-msg-status').textContent=d.success?'✅ Message bheja gaya!':'❌ '+d.error;
  document.getElementById('usr-msg-status').style.color=d.success?'#2e7d32':'#c62828';
}
async function suspendUser(phone){
  const hrs=document.getElementById('usr-suspend-hrs').value;
  const reason=document.getElementById('usr-suspend-reason').value||'Admin action';
  const body={phone,reason};
  if(hrs) body.hours=parseInt(hrs);
  const d=await fetch(API+'/api/admin/users/suspend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  document.getElementById('usr-suspend-status').textContent=d.success?'✅ '+d.message:'❌ '+d.error;
  document.getElementById('usr-suspend-status').style.color=d.success?'#2e7d32':'#c62828';
  if(d.success) setTimeout(()=>{closeUsrModal();loadCustomers();},800);
}
async function unsuspendUser(phone){
  const d=await fetch(API+'/api/admin/users/unsuspend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})}).then(r=>r.json());
  document.getElementById('usr-suspend-status').textContent=d.success?'✅ Unsuspend ho gaya!':'❌ '+d.error;
  document.getElementById('usr-suspend-status').style.color=d.success?'#2e7d32':'#c62828';
  if(d.success) setTimeout(()=>{closeUsrModal();loadCustomers();},800);
}
async function blockUser(phone){
  const reason=document.getElementById('usr-block-reason').value||'Admin action';
  const d=await fetch(API+'/api/admin/users/block',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,reason})}).then(r=>r.json());
  document.getElementById('usr-block-status').textContent=d.success?'✅ Block ho gaya!':'❌ '+d.error;
  document.getElementById('usr-block-status').style.color=d.success?'#2e7d32':'#c62828';
  if(d.success) setTimeout(()=>{closeUsrModal();loadCustomers();},800);
}
async function unblockUser(phone){
  const d=await fetch(API+'/api/admin/users/unblock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})}).then(r=>r.json());
  document.getElementById('usr-block-status').textContent=d.success?'✅ Unblock ho gaya!':'❌ '+d.error;
  document.getElementById('usr-block-status').style.color=d.success?'#2e7d32':'#c62828';
  if(d.success) setTimeout(()=>{closeUsrModal();loadCustomers();},800);
}

// ── Drivers ─────────────────────────────────────────────
async function loadDrivers(){
  try{
    const d=await fetch(API+'/api/admin/drivers').then(r=>r.json());
    document.getElementById('drv-body').innerHTML=d.drivers.map(dr=>`<tr>
      <td><b>${dr.name||'-'}</b></td>
      <td>${dr.phone}</td>
      <td>${dr.vehicle_type} · ${dr.vehicle_no||'-'}</td>
      <td><span class="chip ${dr.is_online?'online':'offline'}">${dr.is_online?'🟢 Online':'⚫ Offline'}</span></td>
      <td class="amount-green">${rupee(dr.balance)}</td>
      <td class="amount-green">${rupee(dr.total_earned)}</td>
      <td>${dr.rating?parseFloat(dr.rating).toFixed(1)+'⭐':'-'}</td>
      <td>
        <button class="action-btn btn-blue" onclick="openDriverMgmtModal('${dr.phone}',${JSON.stringify(dr.name||'')})">Manage</button>
      </td>
    </tr>`).join('');
  }catch(e){document.getElementById('drv-body').innerHTML='<tr><td colspan=8 class=loading>❌ Load failed</td></tr>';}
}

function openDriverMgmtModal(phone,name){
  const m=document.getElementById('drv-modal');
  document.getElementById('drv-modal-content').innerHTML=`
    <h3 style="margin-bottom:14px;font-size:15px">🚗 Driver: ${name} (${phone})</h3>

    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600">📨 Send Message</div>
      <textarea id="dmgmt-msg" placeholder="Driver ko message likhein..." class="input-sm" style="resize:none;height:55px;margin-bottom:6px"></textarea>
      <button class="action-btn btn-blue" style="width:100%;padding:8px" onclick="sendDriverMessage('${phone}')">Send Message</button>
      <div id="dmgmt-msg-status" style="font-size:11px;margin-top:4px"></div>
    </div>

    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600">⏸ Suspend Driver</div>
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <input id="dmgmt-hrs" type="number" placeholder="Hours (empty=permanent)" class="input-sm">
        <input id="dmgmt-reason" placeholder="Reason" class="input-sm">
      </div>
      <div style="display:flex;gap:6px">
        <button class="action-btn btn-orange" style="flex:1;padding:8px" onclick="suspendDriver('${phone}')">⏸ Suspend</button>
        <button class="action-btn btn-green" style="flex:1;padding:8px" onclick="unsuspendDriver('${phone}')">▶️ Unsuspend</button>
      </div>
      <div id="dmgmt-suspend-status" style="font-size:11px;margin-top:4px"></div>
    </div>

    <div>
      <div style="font-size:12px;color:#888;margin-bottom:6px;font-weight:600">🚫 Block Driver</div>
      <input id="dmgmt-block-reason" placeholder="Block reason" class="input-sm" style="margin-bottom:6px">
      <div style="display:flex;gap:6px">
        <button class="action-btn btn-red" style="flex:1;padding:8px" onclick="blockDriver('${phone}')">🚫 Block</button>
        <button class="action-btn btn-green" style="flex:1;padding:8px" onclick="unblockDriver('${phone}')">✅ Unblock</button>
      </div>
      <div id="dmgmt-block-status" style="font-size:11px;margin-top:4px"></div>
    </div>
  `;
  m.classList.add('open');
}
async function sendDriverMessage(phone){
  const msg=document.getElementById('dmgmt-msg').value.trim();
  if(!msg){document.getElementById('dmgmt-msg-status').textContent='❌ Message likhein';return;}
  const d=await fetch(API+'/api/admin/users/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,message:msg})}).then(r=>r.json());
  document.getElementById('dmgmt-msg-status').textContent=d.success?'✅ Bheja!':'❌ '+d.error;
  document.getElementById('dmgmt-msg-status').style.color=d.success?'#2e7d32':'#c62828';
}
async function suspendDriver(phone){
  const hrs=document.getElementById('dmgmt-hrs').value;
  const reason=document.getElementById('dmgmt-reason').value||'Admin action';
  const body={phone,reason};
  if(hrs) body.hours=parseInt(hrs);
  const d=await fetch(API+'/api/admin/users/suspend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  document.getElementById('dmgmt-suspend-status').textContent=d.success?'✅ '+d.message:'❌ '+d.error;
  document.getElementById('dmgmt-suspend-status').style.color=d.success?'#2e7d32':'#c62828';
}
async function unsuspendDriver(phone){
  const d=await fetch(API+'/api/admin/users/unsuspend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})}).then(r=>r.json());
  document.getElementById('dmgmt-suspend-status').textContent=d.success?'✅ Unsuspend!':'❌ '+d.error;
  document.getElementById('dmgmt-suspend-status').style.color=d.success?'#2e7d32':'#c62828';
}
async function blockDriver(phone){
  const reason=document.getElementById('dmgmt-block-reason').value||'Admin action';
  const d=await fetch(API+'/api/admin/users/block',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,reason})}).then(r=>r.json());
  document.getElementById('dmgmt-block-status').textContent=d.success?'✅ Block!':'❌ '+d.error;
  document.getElementById('dmgmt-block-status').style.color=d.success?'#2e7d32':'#c62828';
}
async function unblockDriver(phone){
  const d=await fetch(API+'/api/admin/users/unblock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})}).then(r=>r.json());
  document.getElementById('dmgmt-block-status').textContent=d.success?'✅ Unblock!':'❌ '+d.error;
  document.getElementById('dmgmt-block-status').style.color=d.success?'#2e7d32':'#c62828';
}

// ── Driver Verification ─────────────────────────────────
let _allDrivers=[], _verifyFilter='all';

function setVerifyFilter(f,btn){
  _verifyFilter=f;
  document.querySelectorAll('[id^="vf-"]').forEach(b=>{
    b.style.background='#fff';
    b.style.color=b.getAttribute('data-col')||'#333';
  });
  btn.style.background='#1a1a2e'; btn.style.color='#fff';
  renderVerifications();
}

function vDocBox(photo,label,sub){
  if(photo){
    return '<div style="text-align:center">'
      +'<img src="'+photo+'" class="doc-img" onclick="openImg(\''+photo+'\',\''+label+'\')" onerror="this.style.display=\'none\'">'
      +'<div style="font-size:9px;color:#555;margin-top:3px;font-weight:700">'+label+'</div>'
      +(sub?'<div style="font-size:8px;color:#888">'+sub+'</div>':'')
      +'</div>';
  }
  return '<div style="width:66px;text-align:center;background:#f8f8f8;border-radius:8px;padding:10px 4px;border:2px dashed #e0e0e0">'
    +'<div style="font-size:18px;opacity:.3">&#128196;</div>'
    +'<div style="font-size:9px;color:#bbb;margin-top:2px">'+label+'<br>Missing</div>'
    +'</div>';
}
function vStatusBorder(st){
  if(st==='pending') return '#f59e0b';
  if(st==='resubmit') return '#3b82f6';
  if(st==='approved') return '#16a34a';
  if(st==='rejected') return '#ef4444';
  return '#9ca3af';
}
function vStatusChip(st){
  var bg={approved:'#dcfce7',rejected:'#fee2e2',pending:'#fef3c7',resubmit:'#dbeafe',suspended:'#f3f4f6'};
  var fg={approved:'#166534',rejected:'#991b1b',pending:'#92400e',resubmit:'#1e40af',suspended:'#374151'};
  var lbl={approved:'APPROVED',rejected:'REJECTED',pending:'PENDING',resubmit:'RESUBMIT',suspended:'SUSPENDED'};
  return '<span style="padding:6px 16px;border-radius:20px;font-weight:800;font-size:12px;background:'+(bg[st]||'#eee')+';color:'+(fg[st]||'#333')+';white-space:nowrap">'+(lbl[st]||st.toUpperCase())+'</span>';
}
function vVehicleLabel(dr){
  var icons={bike:'&#x1F3CD;',auto:'&#x1F6FA;',car:'&#x1F695;',eriksha:'&#x1F6F5;',ultra_luxury:'&#x1F48E;'};
  var ic=icons[dr.vehicle_type]||'&#x1F697;';
  var s=ic+' '+(dr.vehicle_type||'-');
  if(dr.vehicle_brand) s+=' &middot; '+dr.vehicle_brand;
  if(dr.vehicle_model) s+=' '+dr.vehicle_model;
  return s;
}

function renderVerifications(){
  var list=_verifyFilter==='all'?_allDrivers:_allDrivers.filter(function(d){return d.verification_status===_verifyFilter;});
  if(!list.length){
    document.getElementById('verify-list').innerHTML='<div class="loading">No drivers for filter: '+_verifyFilter+'</div>';
    return;
  }
  var html='';
  for(var i=0;i<list.length;i++){
    var dr=list[i];
    var st=dr.verification_status||'pending';
    var aadhaarMasked=dr.aadhaar_number?'****'+dr.aadhaar_number.slice(-4):'';
    html+='<div data-card-id="'+dr.id+'" style="border:2px solid '+vStatusBorder(st)+';border-radius:16px;padding:20px;margin-bottom:18px;transition:border-color 0.3s">';

    // Header
    html+='<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">';
    html+='<div>';
    html+='<div style="font-size:18px;font-weight:900;color:#1a1a2e">'+(dr.name||'-')+'</div>';
    html+='<div style="font-size:13px;color:#555;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">';
    html+='<span>&#128241; '+(dr.phone||'-')+'</span>';
    html+='<span style="background:#f0f0f0;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700">'+vVehicleLabel(dr)+'</span>';
    if(dr.vehicle_no) html+='<span style="background:#1a1a2e;color:#fff;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;letter-spacing:1px">'+dr.vehicle_no+'</span>';
    html+='</div>';
    html+='</div>';
    html+='<span class="v-status-chip" style="padding:6px 16px;border-radius:20px;font-weight:800;font-size:12px;background:'+(STATUS_BG[st]||'#eee')+';color:'+(STATUS_COLORS[st]||'#333')+';white-space:nowrap;transition:all 0.3s">'+(st.toUpperCase())+'</span>';
    html+='</div>';

    // Documents
    html+='<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;margin-bottom:14px;padding:12px;background:#fff;border-radius:12px">';
    html+=vDocBox(dr.face_photo,'SELFIE','');
    html+=vDocBox(dr.dl_photo,'DL',dr.dl_name||'');
    html+=vDocBox(dr.vehicle_photo,'VEHICLE',dr.vehicle_no||'');
    if(dr.rc_photo) html+=vDocBox(dr.rc_photo,'RC','');
    html+=vDocBox(dr.aadhaar_photo,'AADHAAR',aadhaarMasked);
    html+='</div>';

    // Info grid
    html+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:14px">';
    html+='<div style="background:#fff;border-radius:10px;padding:10px;border:1px solid #f0f0f0"><div style="font-size:10px;color:#888;font-weight:700;margin-bottom:3px">DL NAME</div><div style="font-size:13px;font-weight:600">'+(dr.dl_name||'&mdash;')+'</div></div>';
    html+='<div style="background:#fff;border-radius:10px;padding:10px;border:1px solid '+(dr.dl_number?'#bfdbfe':'#fee2e2')+'"><div style="font-size:10px;color:#888;font-weight:700;margin-bottom:3px">DL NUMBER</div><div style="font-size:13px;font-weight:700;color:'+(dr.dl_number?'#1565c0':'#dc2626')+'">'+(dr.dl_number||'Not provided')+'</div></div>';
    html+='<div style="background:#fff;border-radius:10px;padding:10px;border:1px solid '+(dr.aadhaar_number?'#bbf7d0':'#fee2e2')+'"><div style="font-size:10px;color:#888;font-weight:700;margin-bottom:3px">AADHAAR</div><div style="font-size:13px;font-weight:700;color:'+(dr.aadhaar_number?'#166534':'#dc2626')+'">'+(aadhaarMasked||'Not provided')+'</div></div>';
    html+='<div class="v-last-msg" style="'+(dr.admin_message?'':'display:none;')+'background:#fffbf0;border-radius:10px;padding:10px;border:1px solid #fde68a;grid-column:1/-1;font-size:13px;color:#78350f">'+(dr.admin_message||'')+'</div>';
    html+='</div>';

    // Action
    html+='<div class="v-actions" style="border-top:1px solid #e5e7eb;padding-top:14px">';
    html+='<div style="font-size:11px;color:#888;margin-bottom:6px;font-weight:600">MESSAGE TO DRIVER:</div>';
    html+='<textarea id="vmsg-'+dr.id+'" rows="2" placeholder="eg. Aapka DL missing hai / Approved ho gaye!" style="width:100%;padding:10px;border:1px solid #e0e0e0;border-radius:10px;font-size:13px;resize:vertical;margin-bottom:10px;font-family:inherit;box-sizing:border-box">'+(dr.admin_message||'')+'</textarea>';
    html+='<div style="display:flex;gap:8px;flex-wrap:wrap">';
    html+='<button data-vid="'+dr.id+'" data-vaction="approved" style="flex:1;min-width:90px;padding:10px 14px;background:#16a34a;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:13px">✅ Approve</button>';
    html+='<button data-vid="'+dr.id+'" data-vaction="resubmit" style="flex:1;min-width:90px;padding:10px 14px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:13px">📋 Resubmit</button>';
    html+='<button data-vid="'+dr.id+'" data-vaction="rejected" style="flex:1;min-width:90px;padding:10px 14px;background:#dc2626;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:13px">❌ Reject</button>';
    html+='<button data-vid="'+dr.id+'" data-vaction="suspended" style="padding:10px 14px;background:#6b7280;color:#fff;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:13px">⏸ Suspend</button>';
    html+='</div>';
    html+='<div id="vstatus-'+dr.id+'" style="font-size:13px;margin-top:8px;font-weight:700"></div>';
    html+='</div>';
    html+='</div>';
  }
  document.getElementById('verify-list').innerHTML=html;

  // Attach click listeners — use raw string ID, never parseInt (breaks UUIDs)
  document.querySelectorAll('[data-vid][data-vaction]').forEach(function(btn){
    btn.addEventListener('click',function(){
      var id=this.getAttribute('data-vid');
      var status=this.getAttribute('data-vaction');
      var msgId='vmsg-'+id;
      verifyDriver(id,status,msgId,this);
    });
  });
}

async function loadVerifications(){
  document.getElementById('verify-list').innerHTML='<div class="loading">Loading...</div>';
  try{
    const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),12000);
    const d=await fetch(API+'/api/admin/driver-verifications',{signal:ctrl.signal}).then(r=>r.json());
    _allDrivers=d.drivers||[];
    const counts={pending:0,resubmit:0,rejected:0,approved:0,suspended:0};
    _allDrivers.forEach(dr=>{ if(counts[dr.verification_status]!==undefined) counts[dr.verification_status]++; });
    document.getElementById('verify-counts').textContent=
      `Total: ${_allDrivers.length} · ⏳${counts.pending} pending · 📋${counts.resubmit} resubmit · ✅${counts.approved} · ❌${counts.rejected}`;
    renderVerifications();
  }catch(e){
    document.getElementById('verify-list').innerHTML='<div class="loading">❌ Load failed: '+e.message+'</div>';
  }
}

var STATUS_COLORS={approved:'#16a34a',rejected:'#dc2626',resubmit:'#2563eb',suspended:'#6b7280',pending:'#f59e0b'};
var STATUS_BG={approved:'#dcfce7',rejected:'#fee2e2',resubmit:'#dbeafe',suspended:'#f3f4f6',pending:'#fef3c7'};

function vUpdateCardInPlace(id,status,adminMsg){
  // Update the card border + status chip without reloading the page
  var card=document.querySelector('[data-card-id="'+id+'"]');
  if(card){
    card.style.borderColor=STATUS_COLORS[status]||'#9ca3af';
    var chip=card.querySelector('.v-status-chip');
    if(chip){
      var lbl={approved:'APPROVED',rejected:'REJECTED',resubmit:'RESUBMIT',suspended:'SUSPENDED',pending:'PENDING'};
      chip.textContent=lbl[status]||status.toUpperCase();
      chip.style.background=STATUS_BG[status]||'#eee';
      chip.style.color=STATUS_COLORS[status]||'#333';
    }
    // Hide action buttons, show done message
    var actDiv=card.querySelector('.v-actions');
    if(actDiv){
      actDiv.innerHTML='<div style="padding:12px;background:'+STATUS_BG[status]+';border-radius:10px;color:'+STATUS_COLORS[status]+';font-weight:700;font-size:14px">✅ '+status.toUpperCase()+' — Saved</div>';
    }
    if(adminMsg){
      var msgBox=card.querySelector('.v-last-msg');
      if(msgBox){msgBox.textContent=adminMsg;msgBox.style.display='block';}
    }
    // Also update _allDrivers cache so filter chips still work
    for(var i=0;i<_allDrivers.length;i++){
      if(String(_allDrivers[i].id)===String(id)){
        _allDrivers[i].verification_status=status;
        if(adminMsg)_allDrivers[i].admin_message=adminMsg;
      }
    }
    // Update count badge
    var counts={pending:0,resubmit:0,rejected:0,approved:0,suspended:0};
    _allDrivers.forEach(function(dr){if(counts[dr.verification_status]!==undefined)counts[dr.verification_status]++;});
    var vc=document.getElementById('verify-counts');
    if(vc)vc.textContent='Total: '+_allDrivers.length+' · ⏳'+counts.pending+' pending · 📋'+counts.resubmit+' resubmit · ✅'+counts.approved+' · ❌'+counts.rejected;
  }
  // Top banner
  var banner=document.getElementById('verify-action-banner');
  if(banner){
    banner.textContent='✅ Driver '+status.toUpperCase()+' — Notification sent';
    banner.style.color=STATUS_COLORS[status];
    banner.style.borderColor=STATUS_COLORS[status];
    banner.style.background=STATUS_BG[status];
    banner.style.display='block';
    setTimeout(function(){banner.style.display='none';},4000);
  }
}

async function verifyDriver(id,status,msgInputId,btn){
  var orig=btn?btn.textContent:'';
  if(btn){btn.disabled=true;btn.textContent='Sending...';}
  var msgEl=document.getElementById(msgInputId);
  var message=msgEl&&msgEl.value.trim()?msgEl.value.trim():null;
  try{
    var resp=await fetch(API+'/api/admin/verify-driver',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({driver_id:id,status:status,message:message})
    });
    var d=await resp.json();
    if(d.success){
      vUpdateCardInPlace(id,status,message);
    } else {
      var el=document.getElementById('vstatus-'+id);
      if(el){el.textContent='❌ '+(d.error||'Error');el.style.color='#dc2626';}
      if(btn){btn.disabled=false;btn.textContent=orig;}
    }
  }catch(e){
    var el=document.getElementById('vstatus-'+id);
    if(el){el.textContent='❌ '+e.message;el.style.color='#dc2626';}
    if(btn){btn.disabled=false;btn.textContent=orig;}
  }
}

// ── Topups ──────────────────────────────────────────────
async function loadTopups(){
  const d=await fetch(API+'/api/admin/topups').then(r=>r.json());
  document.getElementById('topup-body').innerHTML=d.topups.map(t=>`<tr>
    <td>${fmt(t.created_at)}</td><td>${t.user_phone}</td>
    <td class="amount-green">${rupee(t.amount)}</td>
    <td style="font-family:monospace;font-size:10px">${t.payment_id||'—'}</td>
    <td><span class="badge-${t.status}">${t.status}</span></td>
    <td>${t.status==='unverified'?`<button class="action-btn btn-green" onclick="verifyTopup(${t.id})">✓ Verify</button>`:''}</td>
  </tr>`).join('');
}
async function verifyTopup(id){
  await fetch(API+'/api/admin/topups/verify/'+id,{method:'POST'});
  loadTopups();
}

// ── Settings ────────────────────────────────────────────
async function setSurge(){
  const m=parseFloat(document.getElementById('surge-input').value);
  const d=await fetch(API+'/api/admin/surge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({multiplier:m})}).then(r=>r.json());
  const el=document.getElementById('surge-status');
  el.textContent=d.success?`✅ Surge set to ${d.surge}x`:'❌ '+d.error;
  el.style.color=d.success?'#2e7d32':'#c62828';
}
async function updateFare(){
  const v=document.getElementById('fare-vehicle').value;
  const h=parseInt(document.getElementById('fare-hours').value);
  const fare=parseInt(document.getElementById('fare-amount').value);
  const km=parseInt(document.getElementById('fare-km').value);
  const d=await fetch(API+'/api/admin/hourly-fares',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vehicle_type:v,package_hours:h,fare,km})}).then(r=>r.json());
  const el=document.getElementById('fare-status');
  el.textContent=d.success?`✅ Updated: ₹${d.updated.fare}, ${d.updated.km}km`:'❌ '+d.error;
  el.style.color=d.success?'#2e7d32':'#c62828';
  loadFares();
}
async function loadFares(){
  const d=await fetch(API+'/api/hourly/fares').then(r=>r.json());
  document.getElementById('surge-input').value=d.surge||1.0;
  const vehicles=Object.keys(d.fares);
  const pkgs=[2,4,6,8,24,48,72];
  let html=`<div style="overflow-x:auto"><table style="font-size:11px"><thead><tr>
    <th>Vehicle</th>${pkgs.map(p=>`<th style="text-align:center">${p>=24?p/24+'d':p+'h'}</th>`).join('')}<th style="text-align:center">Extra/km</th>
  </tr></thead><tbody>`;
  vehicles.forEach(v=>{
    html+=`<tr><td style="font-weight:700;text-transform:capitalize">${v}</td>`;
    pkgs.forEach(p=>{
      const pkg=d.fares[v][p];
      html+=pkg?`<td style="text-align:center">₹${pkg.fare}<br><span style="color:#aaa;font-size:9px">${pkg.km}km</span></td>`:'<td style="text-align:center;color:#ddd">—</td>';
    });
    html+=`<td style="text-align:center">₹${d.fares[v].extra}/km</td></tr>`;
  });
  html+='</tbody></table></div>';
  document.getElementById('fares-display').innerHTML=html;
}

// ── Marketing ───────────────────────────────────────────
async function createCampaign(){
  const title=document.getElementById('camp-title').value.trim();
  const body=document.getElementById('camp-body').value.trim();
  const target=document.getElementById('camp-target').value;
  const type=document.getElementById('camp-type').value;
  const promo_code=document.getElementById('camp-promo').value.trim()||null;
  const cta_label=document.getElementById('camp-cta').value.trim()||null;
  const expires_at=document.getElementById('camp-expires').value||null;
  if(!title){document.getElementById('camp-status').textContent='❌ Title zaroori hai';return;}
  const d=await fetch(API+'/api/admin/campaigns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body,target,type,promo_code,cta_label,expires_at})}).then(r=>r.json());
  document.getElementById('camp-status').textContent=d.success?'✅ Campaign launch ho gaya!':'❌ '+d.error;
  if(d.success){document.getElementById('camp-title').value='';document.getElementById('camp-body').value='';loadCampaigns();}
}
async function loadCampaigns(){
  const d=await fetch(API+'/api/admin/campaigns').then(r=>r.json());
  document.getElementById('campaigns-list').innerHTML=d.campaigns.length?d.campaigns.map(c=>`
    <div style="display:flex;align-items:center;gap:10px;padding:10px;border-radius:10px;background:${c.active?'#f8f9fa':'#fff'};margin-bottom:8px;border:1px solid #f0f0f0">
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${c.title}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">${c.body||''}</div>
        <div style="font-size:10px;color:#aaa;margin-top:3px">Target: ${c.target} · Type: ${c.type}${c.promo_code?' · Code: '+c.promo_code:''}${c.expires_at?' · Expires: '+fmt(c.expires_at):' · No expiry'}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <span style="background:${c.active?'#e8f5e9':'#f5f5f5'};color:${c.active?'#2e7d32':'#999'};padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700">${c.active?'LIVE':'PAUSED'}</span>
        <button class="action-btn ${c.active?'btn-orange':'btn-green'}" onclick="toggleCampaign(${c.id})">${c.active?'Pause':'Resume'}</button>
        <button class="action-btn btn-red" onclick="deleteCampaign(${c.id})">Delete</button>
      </div>
    </div>
  `).join(''):'<div style="text-align:center;color:#bbb;padding:20px">Koi campaign nahi</div>';
}
async function toggleCampaign(id){await fetch(API+'/api/admin/campaigns/toggle/'+id,{method:'POST'});loadCampaigns();}
async function deleteCampaign(id){if(!confirm('Delete?'))return;await fetch(API+'/api/admin/campaigns/'+id,{method:'DELETE'});loadCampaigns();}

async function sendBroadcast(){
  const title=document.getElementById('notif-title').value.trim();
  const body=document.getElementById('notif-body').value.trim();
  const target=document.getElementById('notif-target').value;
  if(!title||!body){document.getElementById('notif-status').textContent='❌ Title aur body zaroori hai';return;}
  document.getElementById('notif-status').textContent='⏳ Bhej raha hai...';
  document.getElementById('notif-status').style.color='#e65100';
  const d=await fetch(API+'/api/admin/notify-all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body,target})}).then(r=>r.json());
  document.getElementById('notif-status').textContent=d.success?`✅ Bheja! ${d.total_targets} users ko`:'❌ '+d.error;
  document.getElementById('notif-status').style.color=d.success?'#2e7d32':'#c62828';
}

async function createPromo(){
  const code=document.getElementById('promo-code').value.toUpperCase().trim();
  const discount_type=document.getElementById('promo-type').value;
  const discount_value=parseFloat(document.getElementById('promo-value').value)||0;
  const max_discount=parseFloat(document.getElementById('promo-max').value)||null;
  const min_fare=parseFloat(document.getElementById('promo-minfare').value)||0;
  const usage_limit=parseInt(document.getElementById('promo-limit').value)||null;
  if(!code||!discount_value){document.getElementById('promo-create-status').textContent='❌ Code aur discount zaroori';return;}
  const d=await fetch(API+'/api/admin/promos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,discount_type,discount_value,max_discount,min_fare,usage_limit})}).then(r=>r.json());
  document.getElementById('promo-create-status').textContent=d.success?'✅ Promo create ho gaya!':'❌ '+d.error;
  if(d.success) loadPromos();
}
async function loadPromos(){
  const d=await fetch(API+'/api/admin/promos').then(r=>r.json());
  document.getElementById('promos-list').innerHTML=d.promos.length?`<table style="font-size:11px">
    <thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Used</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${d.promos.map(p=>`<tr>
      <td style="font-weight:700;font-family:monospace">${p.code}</td>
      <td>${p.discount_type==='flat'?'Flat':'%'}</td>
      <td>${p.discount_type==='flat'?'₹':''}${p.discount_value}${p.discount_type==='percent'?'%':''}</td>
      <td>${p.used_count||0}${p.usage_limit?'/'+p.usage_limit:''}</td>
      <td><span style="background:${p.active?'#e8f5e9':'#ffebee'};color:${p.active?'#2e7d32':'#c62828'};padding:1px 7px;border-radius:6px;font-size:10px;font-weight:700">${p.active?'ON':'OFF'}</span></td>
      <td><button class="action-btn ${p.active?'btn-red':'btn-green'}" onclick="togglePromo('${p.code}',${!p.active})">${p.active?'Disable':'Enable'}</button></td>
    </tr>`).join('')}</tbody></table>`:'<div style="color:#bbb;padding:16px;text-align:center">Koi promo nahi</div>';
}
async function togglePromo(code,active){
  await fetch(API+'/api/admin/promos/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,active})});
  loadPromos();
}

async function loadReferrals(){
  const d=await fetch(API+'/api/admin/referrals').then(r=>r.json());
  document.getElementById('referral-stats').innerHTML=`
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="background:#e8f5e9;border-radius:10px;padding:10px 18px;text-align:center"><div style="font-size:20px;font-weight:800;color:#2e7d32">${d.total}</div><div style="font-size:10px;color:#666">Total Referrals</div></div>
      <div style="background:#e8f5e9;border-radius:10px;padding:10px 18px;text-align:center"><div style="font-size:20px;font-weight:800;color:#2e7d32">${d.completed}</div><div style="font-size:10px;color:#666">Completed</div></div>
      <div style="background:#fff3e0;border-radius:10px;padding:10px 18px;text-align:center"><div style="font-size:20px;font-weight:800;color:#e65100">${rupee(d.total_reward)}</div><div style="font-size:10px;color:#666">Total Rewarded</div></div>
    </div>
  `;
  document.getElementById('referral-body').innerHTML=d.recent.map(r=>`<tr>
    <td>${fmt(r.created_at)}</td>
    <td>${r.referrer_name||'-'} (${r.referrer_phone})</td>
    <td>${r.referred_name||'-'} (${r.referred_phone})</td>
    <td class="amount-green">${rupee(r.reward_amount)}</td>
  </tr>`).join('');
}

// ── Bootstrap ───────────────────────────────────────────
console.log('[Admin] Script loaded OK');
async function loadAll(){
  console.log('[Admin] loadAll start');
  document.getElementById('last-refresh').textContent=new Date().toLocaleTimeString('en-IN');
  await loadDashboard();
  await loadTransactions();
  console.log('[Admin] loadAll done');
}
loadAll();

