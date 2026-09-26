const {call, boot, G} = require('./mockgas');
let fails=0; const ok=(c,m)=>{ if(!c){ fails++; console.log('FAIL', m);} };
const r=(b)=>{ const o=call(b); return o; };
// bootstrap admin
let a = r({action:'join', code:boot, name:'佩芝', password:'1234'}); ok(a.ok, 'boot join '+JSON.stringify(a));
const A = a.data.token;
ok(!r({action:'join', code:boot, name:'X', password:'1234'}).ok, 'boot code single use');
let t = r({action:'createTrip', token:A, title:'花蓮三天兩夜', dest:'花蓮', startDate:'2026-10-10', days:3, mode:'開車', maxPeople:4}); ok(t.ok,'create');
const tid=t.data.tripId, code=t.data.inviteCode;
let info=r({action:'inviteInfo', code}); ok(info.ok && info.data.count===1,'invite info');
let b=r({action:'join', code, name:'阿哲', password:'abcd'}); ok(b.ok,'join b'); const B=b.data.token;
let dup=r({action:'join', code, name:'阿哲', password:'abcd'}); ok(!dup.ok && dup.code==='nameTaken' && dup.extra.suggest.length,'dup name '+JSON.stringify(dup));
let c=r({action:'join', code, name:'123', password:'abcd'}); ok(c.ok,'numeric name'); const C=c.data.token;
let lc=r({action:'login', name:'123', password:'abcd'}); ok(lc.ok,'login numeric name '+JSON.stringify(lc));
let d=r({action:'join', code, name:'小安', password:'abcd'}); ok(d.ok,'join d'); const D=d.data.token;
ok(r({action:'join', code, name:'第五人', password:'abcd'}).code==='tripFull','trip full');
// places
let p1=r({action:'addPlace', token:B, tripId:tid, name:'太魯閣步道', type:'玩'}); ok(p1.ok,'addplace');
ok(r({action:'addPlace', token:C, tripId:tid, name:'太魯閣步道 ', type:'玩'}).code==='dup','dup place');
let p2=r({action:'addPlace', token:C, tripId:tid, name:'東大門夜市', type:'吃'});
ok(r({action:'vote', token:A, placeId:p1.data.placeId}).data.voted===true,'vote');
ok(r({action:'vote', token:A, placeId:p1.data.placeId}).data.voted===false,'unvote');
r({action:'vote', token:A, placeId:p1.data.placeId});
let g=r({action:'getTrip', token:B, tripId:tid}); ok(g.ok && g.data.places[0].votes===2 && g.data.places[0].myVote,'votes '+JSON.stringify(g.data&&g.data.places));
ok(g.data.trip.startDate==='2026-10-10','date stays text '+g.data.trip.startDate);
ok(!r({action:'endCollect', token:B, tripId:tid, picks:[]}).ok,'member cannot end');
ok(r({action:'endCollect', token:A, tripId:tid, picks:[p1.data.placeId]}).ok,'end collect');
let p3=r({action:'addPlace', token:D, tripId:tid, name:'七星潭', type:'玩'}); ok(p3.data.status==='backlog','backlog after collect');
const itin={title:'x',days:[{day:1,date:'2026-10-10',stops:[{time:'09:00',name:'太魯閣步道',type:'玩'}]},{day:2,date:'2026-10-11',stops:[]}]};
let s1=r({action:'saveItinerary', token:A, tripId:tid, data:itin}); ok(s1.ok && s1.data.ver===1,'save itin');
ok(r({action:'saveItinerary', token:A, tripId:tid, data:itin, baseVer:0}).code==='conflict','conflict');
let sb=r({action:'scheduleBacklog', token:A, tripId:tid, placeId:p3.data.placeId, day:1, time:'10:00'}); ok(sb.ok && sb.data.ver===2,'schedule backlog');
g=r({action:'getTrip', token:A, tripId:tid}); ok(g.data.itinerary.data.days[1].stops[0].name==='七星潭','backlog in day2');
ok(r({action:'finalize', token:A, tripId:tid}).ok,'finalize');
// tasks
let k=r({action:'addTask', token:A, tripId:tid, title:'訂民宿'}); const kid=k.data.taskId;
ok(r({action:'claimTask', token:B, taskId:kid}).ok,'claim');
ok(!r({action:'claimTask', token:C, taskId:kid}).ok,'double claim');
ok(r({action:'requestTask', token:C, taskId:kid}).ok,'request');
ok(r({action:'answerTakeover', token:B, taskId:kid, accept:true}).ok,'accept takeover');
g=r({action:'getTrip', token:A, tripId:tid}); ok(g.data.tasks[0].ownerName==='123','takeover owner');
ok(r({action:'giveUpTask', token:C, taskId:kid}).ok,'give up');
ok(r({action:'assignTask', token:A, taskId:kid, userId:g.data.members[3].userId}).ok,'assign');
// expenses: 民宿 4000 A付 4人平分; 晚餐 2400 C付 3人(not D) ; 租車 1000 B付 3人 -> remainder
const M=Object.fromEntries(g.data.members.map(m=>[m.name,m.userId]));
const all=[M['佩芝'],M['阿哲'],M['123'],M['小安']];
const sh=(ids)=>Object.fromEntries(ids.map(i=>[i,1]));
ok(r({action:'addExpense', token:A, tripId:tid, title:'民宿', amount:4000, paidBy:M['佩芝'], splitMode:'equal', shares:sh(all)}).ok,'exp1');
ok(r({action:'addExpense', token:C, tripId:tid, title:'晚餐', amount:2400, paidBy:M['123'], splitMode:'equal', shares:sh([M['佩芝'],M['阿哲'],M['123']])}).ok,'exp2');
ok(r({action:'addExpense', token:B, tripId:tid, title:'油錢', amount:1000, paidBy:M['阿哲'], splitMode:'equal', shares:sh([M['佩芝'],M['阿哲'],M['小安']])}).ok,'exp3');
ok(r({action:'addExpense', token:B, tripId:tid, title:'bad', amount:100, paidBy:M['阿哲'], splitMode:'custom', shares:{[M['佩芝']]:50}}).code==='bad','custom mismatch');
g=r({action:'getTrip', token:A, tripId:tid});
const st=g.data.settle; const sum=st.rows.reduce((s,x)=>s+x.diff,0);
ok(sum===0,'diffs sum 0 '+sum);
console.log(st.rows.map(x=>x.name+' 付'+x.paid+' 該'+x.owed+' 差'+x.diff).join(' | '));
console.log(st.transfers.map(x=>x.fromName+'→'+x.toName+' '+x.amount).join(' | '));
ok(st.transfers.length<=3,'min transfers');
ok(r({action:'cancelTrip', token:A, tripId:tid, confirm:'花蓮三天兩夜'}).code==='hasExpense','cannot cancel w/ expense');
ok(r({action:'archiveTrip', token:A, tripId:tid}).code==='unsettled','cannot archive unsettled');
for(const x of st.transfers){
  const payer = {[M['佩芝']]:A,[M['阿哲']]:B,[M['123']]:C,[M['小安']]:D};
  ok(r({action:'markPaid', token:payer[x.from], tripId:tid, from:x.from, to:x.to}).ok,'markPaid');
  ok(r({action:'confirmPaid', token:payer[x.to], tripId:tid, from:x.from, to:x.to}).ok,'confirm');
}
g=r({action:'getTrip', token:A, tripId:tid}); ok(g.data.settle.transfers.every(x=>x.status==='confirmed'),'all confirmed');
ok(r({action:'archiveTrip', token:A, tripId:tid}).ok,'archive');
ok(!r({action:'addPlace', token:B, tripId:tid, name:'x'}).ok,'closed trip readonly');
// owner caps, cancel/restore, transfer
const ids=[];
for(let i=0;i<3;i++){ const x=r({action:'createTrip', token:A, title:'團'+i, days:1}); ok(x.ok,'create '+i); ids.push(x.data.tripId); }
ok(r({action:'createTrip', token:A, title:'團4', days:1}).code==='ownedFull','owned cap');
ok(r({action:'cancelTrip', token:A, tripId:ids[0], confirm:'團0'}).ok,'cancel');
ok(r({action:'createTrip', token:A, title:'團5', days:1}).ok,'create after cancel');
ok(r({action:'restoreTrip', token:A, tripId:ids[0]}).code==='ownedFull','restore blocked by cap');
let en=r({action:'ended', token:A}); ok(en.data.trips.length===2,'ended lists archived+cancelled '+en.data.trips.length);
// transfer: invite B into ids[1]
const c1=r({action:'getTrip', token:A, tripId:ids[1]}).data.trip.inviteCode;
ok(r({action:'login', name:'阿哲', password:'abcd', code:c1}).data.tripId===ids[1],'login joins');
ok(r({action:'transferOwner', token:A, tripId:ids[1], userId:M['阿哲']}).ok,'transfer req');
ok(r({action:'myTrips', token:B}).data.pendingTransfer.length===1,'pending transfer');
ok(r({action:'answerTransfer', token:B, tripId:ids[1], accept:true}).ok,'accept transfer');
ok(r({action:'restoreTrip', token:A, tripId:ids[0]}).ok,'restore after transfer freed slot');
ok(!r({action:'leaveTrip', token:B, tripId:ids[1]}).ok,'owner cannot leave');
// reset pw
const rp=r({action:'resetMemberPw', token:B, tripId:ids[1], userId:M['佩芝']}); ok(rp.ok,'reset pw');
const lt=r({action:'login', name:'佩芝', password:rp.data.temp}); ok(lt.ok && lt.data.mustChangePw,'temp login');
ok(r({action:'login', name:'佩芝', password:'1234'}).ok,'old pw still ok');
ok(r({action:'getTrip', token:'nope', tripId:tid}).code==='auth','bad token');
const up=r({action:'updates', token:B, tripId:tid}); ok(up.ok && up.data.list.length>5,'updates');
// formula injection
const fi=r({action:'addPlace', token:A, tripId:ids[2], name:'=IMPORTXML("x")'}); ok(fi.ok,'formula name stored');
ok(r({action:'getTrip', token:A, tripId:ids[2]}).data.places[0].name==='=IMPORTXML("x")','formula stored as text');
G.purge();
console.log(fails? fails+' FAILED':'ALL OK');
