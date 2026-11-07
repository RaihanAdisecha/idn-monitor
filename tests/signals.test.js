'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {socAssess,socTopics}=require('../social');
const H=require('../social-history');
const now=Date.now();
test('metaphorical tsunami and foreign elections do not become incidents',()=>{
 for(const t of ['Blue Tsunami, Empty Promises via @YouTube','Van blauwe tsunami naar rode aandelenmarkt','The opposition in Oyo and Osun will face a Tsunami','Tsunami suara pemilu di Indonesia'])assert.equal(socAssess(t).signalEligible,false,t);
});
test('single-sentence event plus separate idiom remains an event',()=>{
 const a=socAssess('Kebakaran jenggot melihat berita ini. Kebakaran rumah di Bekasi menewaskan dua warga.');assert.equal(a.signalEligible,true);assert.equal(a.events[0].location.name,'Bekasi');
});
test('foreign incident cannot borrow reader location from another clause',()=>{
 const a=socAssess('Gempa di Jepang. Saya membacanya dari Jakarta.');assert.equal(a.signalEligible,false);assert.equal(a.scope,'foreign');
});
test('negation, education, response and metaphor are not live incidents',()=>{
 for(const t of ['Gempa tidak terjadi di Aceh, video itu hoaks','Apa itu ransomware? Tutorial menghapus malware','Tidak ada kebocoran data, kabar peretasan itu hoaks','i have been single for 52 years; humans are malware infected'])assert.equal(socAssess(t).signalEligible,false,t);
});
test('targeted local cyber incident qualifies, vague mentions do not',()=>{
 assert.equal(socAssess('PDN diserang ransomware, server terenkripsi').signalEligible,true);
 for(const t of ['malware','Apa itu ransomware?','Ransomware hits hospital in London'])assert.equal(socAssess(t).signalEligible,false,t);
});
test('local disaster reports and official warnings remain eligible',()=>{
 for(const t of ['Gempa magnitudo 5 mengguncang Aceh, warga waspada','BMKG: peringatan dini tsunami di Aceh','Gunung Marapi erupsi, hujan abu guyur Agam'])assert.equal(socAssess(t).signalEligible,true,t);
});
test('non-event advisory and bantuan text do not become incident topic',()=>{
 for(const t of ['Respons cepat bencana, salurkan bantuan untuk warga','Alasan isi tas bencana harus berisi kebutuhan darurat'])assert.equal(socTopics(t).includes('gempa'),false,t);
});
test('classification version is stored and recomputed on every tag',()=>{
 const p={text:'Blue tsunami',url:'x1',ts:now};assert.equal(H.tag(p),false);assert.equal(p.assessment.version,require('../assessment').VERSION);
});
test('future, stale and invalid times are rejected',()=>{
 for(const ts of [0,now+1,now-25*3600e3,NaN])assert.equal(H.tag({text:'Gempa magnitudo 5 di Aceh',ts},[],now),false,String(ts));
});
test('multi-topic history balancing never exceeds an existing topic cap',()=>{
 const rows=Array.from({length:12},(_,i)=>({topics:i<8?['a','b']:['b'],ts:now-i}));
 const out=require('../social').socBalance(rows,30,()=> 'u',.25,30);assert.equal(out.filter(x=>x.topics.includes('a')).length,8);assert.equal(out.filter(x=>x.topics.includes('b')).length,8);
});
test('trending uses distinct account-window units and rejects future timestamps',()=>{
 const {socHot}=require('../social');const rows=['a','b','c'].map(user=>({topics:['gempa'],platform:'x',user,ts:now+86400000}));assert.equal(socHot(rows,now).hot.length,0);
});

test('expanded physical incident taxonomy preserves collapse, crime and disease events',()=>{
 const cases=[['Gedung ambruk di Bandung menimpa warga','insiden'],['Pembunuhan terjadi di Bekasi','kriminal'],['Kasus DBD bertambah di Depok','kesehatan'],['Kapal tenggelam di perairan Aceh','insiden']];
 for(const [text,category] of cases){const a=socAssess(text);assert.equal(a.signalEligible,true,text);assert.ok(a.events.some(e=>e.category===category),text);}
});

test('user-provided political tsunami, MEXC commentary and metaphor rant never become signals',()=>{
 const examples=[
  'LMAO, Tweet bookmarked. In the last 2 months, I have been to 4 of the 6 SW states, the only state opposition members have any chance in NA elections is only in Oyo (APM members) & Osun (some Accord members especially in Osun West). The rest will be a Tsunami.',
  'CÓ BIẾN LỚN: MEXC BỊ MỸ SỜ GÁY VỤ 16 TỶ ĐÔ. FinCEN đưa sàn vào danh sách đen; cộng đồng crypto membahas ransomware dan hacker. P2P USDT turun.',
  "I've been single for 52 years. I knew humans were malware infected decades ago, weird energy spikes from the malware infected. Humans assimilated the operating system into 100% malware."
 ];
 for(const text of examples)assert.equal(socAssess(text).signalEligible,false,text);
});
