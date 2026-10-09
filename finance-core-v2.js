/* So Quy 2.0.4 - finance core + verified opening-balance allocation. */
(function(g){
 const arr=v=>Array.isArray(v)?v:[];
 const num=v=>Number.isFinite(Number(v))?Number(v):0;
 const stable=(prefix,i)=>`${prefix}-${i+1}`;
 function migrateDb(raw){
  raw=raw&&typeof raw==='object'?raw:{};
  const db={...raw};
  db.schemaVersion=2;
  db.funds=arr(raw.funds).map((x,i)=>({id:x.id||stable('fund',i),name:x.name||`Quỹ ${i+1}`,scope:x.scope||'personal',...x}));
  db.accounts=arr(raw.accounts).map((x,i)=>({id:x.id||stable('account',i),name:x.name||`Tài khoản ${i+1}`,kind:x.kind||'cash_or_bank',openingBalance:num(x.openingBalance),openingByFund:(x.openingByFund&&typeof x.openingByFund==='object')?x.openingByFund:{},liquid:x.liquid!==false,...x}));
  db.tx=arr(raw.tx).map((x,i)=>({id:x.id||stable('tx',i),type:x.type||'expense',date:x.date||'',amount:num(x.amount),commonCode:x.commonCode||'',personalCode:x.personalCode||'',method:x.method||'',content:x.content||x.category||'',category:x.category||x.content||'',note:x.note||'',...x}));
  db.codes=arr(raw.codes);
  db.partners=arr(raw.partners);
  db.debts=arr(raw.debts).map((x,i)=>({id:x.id||stable('debt',i),principal:num(x.principal),paid:num(x.paid),status:x.status||'open',...x}));
  db.investments=arr(raw.investments).map((x,i)=>({id:x.id||stable('investment',i),cost:num(x.cost),addedCost:num(x.addedCost),redeemed:num(x.redeemed),status:x.status||'open',...x}));
  return db;
 }
 function calc(db0){
  const db=migrateDb(db0), account={}, fund={}, matrix={};
  for(const a of db.accounts){account[a.id]=0;matrix[a.id]={};for(const f of db.funds)matrix[a.id][f.id]=0;}
  for(const f of db.funds)fund[f.id]=0;
  const add=(aid,fid,v)=>{if(account[aid]===undefined||fund[fid]===undefined)return;account[aid]+=v;fund[fid]+=v;matrix[aid][fid]=(matrix[aid][fid]||0)+v;};
  // Opening balance must belong to a fund as well as an account; otherwise account totals and fund totals diverge.
  // New data can store openingByFund. Legacy openingBalance is assigned to the first personal fund (or first fund) for backward compatibility.
  const fallbackFund=(db.funds.find(f=>f.scope==='personal')||db.funds[0])?.id;
  for(const a of db.accounts){
   const entries=Object.entries(a.openingByFund||{}).filter(([fid])=>fund[fid]!==undefined);
   if(entries.length){for(const [fid,v] of entries)add(a.id,fid,num(v));}
   else if(num(a.openingBalance)!==0&&fallbackFund)add(a.id,fallbackFund,num(a.openingBalance));
  }
  for(const t of db.tx){const v=num(t.amount);switch(t.type){
   case'income': add(t.account,t.fund,v);break;
   case'expense': add(t.account,t.fund,-v);break;
   case'fund_transfer': add(t.account,t.fund,-v);add(t.account,t.toFund,v);break;
   case'account_transfer': add(t.account,t.fund,-v);add(t.toAccount,t.fund,v);break;
   case'loan_out': add(t.account,t.fund,-v);break;
   case'loan_repayment_in': add(t.account,t.fund,v);break;
   case'borrow_in': add(t.account,t.fund,v);break;
   case'debt_repayment_out': add(t.account,t.fund,-v);break;
   case'investment_buy': add(t.account,t.fund,-v);break;
   case'investment_redeem': add(t.account,t.fund,v);break;
  }}
  const receivable=db.debts.filter(x=>x.direction==='receivable'&&x.status!=='closed').reduce((s,x)=>s+Math.max(0,num(x.principal)-num(x.paid)),0);
  const payable=db.debts.filter(x=>x.direction==='payable'&&x.status!=='closed').reduce((s,x)=>s+Math.max(0,num(x.principal)-num(x.paid)),0);
  const investmentValue=db.investments.filter(x=>x.status!=='closed').reduce((s,x)=>s+num(x.currentValue??x.cost),0);
  const cashTotal=Object.values(account).reduce((s,v)=>s+v,0);
  const liquidCash=db.accounts.filter(a=>a.liquid!==false).reduce((s,a)=>s+num(account[a.id]),0);
  return {account,fund,matrix,cashTotal,liquidCash,receivable,payable,netDebt:receivable-payable,investmentValue,totalAssets:cashTotal+receivable+investmentValue-payable};
 }
 function monthSummary(db0,month){const db=migrateDb(db0);let income=0,expense=0;for(const t of db.tx){if(month&&!String(t.date).startsWith(month))continue;if(t.type==='income')income+=num(t.amount);if(t.type==='expense')expense+=num(t.amount);}return{income,expense,net:income-expense};}
 g.SoQuyFinanceV2={migrateDb,calc,monthSummary};
})(globalThis);
