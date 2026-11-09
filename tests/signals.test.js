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

test('food poisoning, MBG poisoning, and toxic liquor qualify as health incidents',()=>{
 const cases=[
   ['Belasan siswa SDN di Cirebon diduga keracunan MBG, dilarikan ke rumah sakit', 'kesehatan'],
   ['Warga di Kebumen keracunan massal usai santap makanan resepsi', 'kesehatan'],
   ['Tiga warga tewas usai pesta miras oplosan di Tasikmalaya', 'kesehatan']
 ];
 for(const [text, category] of cases){
   const a=socAssess(text);
   assert.equal(a.signalEligible, true, text);
   assert.ok(a.events.some(e => e.category === category), text);
 }
});

test('user-provided political tsunami, MEXC commentary and metaphor rant never become signals',()=>{
 const examples=[
  'LMAO, Tweet bookmarked. In the last 2 months, I have been to 4 of the 6 SW states, the only state opposition members have any chance in NA elections is only in Oyo (APM members) & Osun (some Accord members especially in Osun West). The rest will be a Tsunami.',
  'CÓ BIẾN LỚN: MEXC BỊ MỸ SỜ GÁY VỤ 16 TỶ ĐÔ. FinCEN đưa sàn vào danh sách đen; cộng đồng crypto membahas ransomware dan hacker. P2P USDT turun.',
  "I've been single for 52 years. I knew humans were malware infected decades ago, weird energy spikes from the malware infected. Humans assimilated the operating system into 100% malware."
 ];
 for(const text of examples)assert.equal(socAssess(text).signalEligible,false,text);
});

test('football banter, Asian drama SEO and trend stuffing copypasta never leak into signals or topics',()=>{
 const {socKeepX}=require('../social');
 const leakingPost='Pemabuk diperlukan pelacur jalanan @ManUtd bermahkotakan duri tajam #MUFC Tutup matamu kawan @carras16 besarkan hati @persib surga SID Bukan Pahlawan Kim Jiwon of Doctor X Meng Ziyi of Tigers sniff the rose Emyu baby gempa #PERSIB BANDUNG indonesia KRAKATAU SEMERU';
 assert.equal(socAssess(leakingPost).signalEligible,false);
 assert.equal(socTopics(leakingPost).includes('gempa'),false);
 assert.equal(socKeepX({text:leakingPost,likes:0}),false);
});

test('Indonesian metaphors, idioms, slang and pop culture across all categories never become signals',()=>{
 const idiomCases=[
   ['Wah gempa lokal nih pas dia lewat depan kelas','gempa'],
   ['Baby gempa lucu banget tingkahnya hari ini','gempa'],
   ['Karakter Boboiboy Gempa kekuatannya paling stabil di serialnya','gempa'],
   ['Jual baju gempa kaos distro murah bahan katun','gempa'],
   ['Lagu goyang gempa ini lagi viral di TikTok dan Reels','gempa'],
   ['Guncangan politik jelang reshuffle kabinet kian memanas','gempa'],
   ['Badai cedera menghantam lini belakang klub jelang laga derby','badai'],
   ['Kebijakan baru menteri menuai badai kritik dari publik','badai'],
   ['Penampilan artis itu di panggung semalam cantik badai abis','badai'],
   ['Suasana konser pecah panggung terbakar semangat penonton','kebakaran'],
   ['Sayap-sayap patah terbakar api cemburu yang tak kunjung padam','kebakaran'],
   ['Pernyataan politisi itu tabrakan logika dan membingungkan warga','kecelakaan'],
   ['Rancangan aturan baru dinilai menabrak konstitusi dan asas keadilan','kecelakaan'],
   ['Pejabat tersebut tergelincir lidah saat sesi konferensi pers','insiden'],
   ['Jembatan cinta kenangan kita kini hanya tinggal cerita lama','insiden'],
   ['Dapat durian runtuh menang undian motor dari bank kemarin sore','insiden'],
   ['Semua hadirin hanyut dalam suasana haru pembacaan puisi','banjir'],
   ['Keluarga korban tenggelam dalam duka mendalam atas kepergiannya','insiden'],
   ['Aduh kena racun shopee lagi checkout barang diskonan banyak banget','kesehatan'],
   ['Cowok itu udah keracunan cinta sampai buta sama kelakuan pasangannya','kesehatan'],
   ['Wabah judol sudah merusak generasi muda di berbagai daerah','kesehatan'],
   ['Ditembak mati rasa hatiku tak lagi mampu mencintai siapa pun','penembakan'],
   ['Tim tamu sukses curi poin penuh di kandang lawan pekan ini','pencurian'],
   ['Waspada sindikat begal rekening dengan modus phishing APK kurir paket','kriminal']
 ];
 for(const [text,forbiddenTopic] of idiomCases){
   const a=socAssess(text);
   assert.equal(a.signalEligible,false,`Expected signalEligible=false for: ${text}`);
   const topics=socTopics(text);
   assert.equal(topics.includes(forbiddenTopic),false,`Expected ${forbiddenTopic} excluded from topics for: ${text}`);
 }
});

test('genuine citizen and official seismic and disaster reports remain verified signals',()=>{
 const genuineCases=[
   ['BMKG: Gempa magnitudo 5.2 guncang Sukabumi, getaran terasa hingga Bandung','gempa'],
   ['Gempa terasa kencang banget di Garut barusan, warga berhamburan keluar rumah','gempa'],
   ['Gunung Semeru meletus lagi pagi ini, semburkan awan panas guguran sejauh 3 km','gempa'],
   ['Puting beliung terjang pemukiman warga di Ciamis, puluhan atap rumah rusak','badai']
 ];
 for(const [text,expectedTopic] of genuineCases){
   const a=socAssess(text);
   assert.equal(a.signalEligible,true,`Expected signalEligible=true for: ${text}`);
   assert.equal(a.scope,'Indonesia',`Expected scope=Indonesia for: ${text}`);
   const topics=socTopics(text);
   assert.ok(topics.includes(expectedTopic),`Expected topics to include ${expectedTopic} for: ${text}`);
 }
});
