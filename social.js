'use strict';

const ASSESS = require('./assessment');
const CLUSTER = require('./social-cluster');
const DIAG = require('./social-diagnostics');

const diagnostics = DIAG.createDiagnostics();

const SOC_NOISE_RE = /(kebakaran jenggot|kebakaran (harga|promo|diskon|obral)|tersulut api (amarah|cemburu|emosi|dendam)|terbakar (api )?(amarah|cemburu|emosi|semangat|rindu|api asmara)|(?:membakar|sulut) (semangat|jiwa|emosi|amarah|nyali)|bakar (duit|uang|kalori|lemak)|gempa (politik|kabinet|pasar|saham|hati|rasa|jantung|lokal)|baby\s+gempa|boboiboy\s+gempa|baju\s+gempa|kaos\s+gempa|goyang\s+gempa|joget\s+gempa|lagu\s+gempa|bikin\s+gempa|mengguncang (jagat|dunia|medsos|panggung|publik|politik|parlemen|bursa|klasemen|pasar)|guncangan\s+(?:jiwa|batin|emosi|politik|ekonomi|keuangan)|(?:post[- ]?)?(?:blue|blauwe)[- ]?tsunami|ocean\s+tsunami|surfing\s+(?:a\s+)?tsunami|tsunami (phk|impor|produk|barang|utang|inflasi|suara|politik|protes|biru|vonis)|badai (krisis|resesi|phk|inflasi|keuangan|kebangkrutan|pemecatan|kehidupan|asmara|pasti berlalu|kritik|protes|kecaman|hujatan|komentar)|angin segar (bagi|untuk)|ledakan (kasus|pasien|dbd|wabah|penduduk|populasi|inflasi|harga|daya beli|pengangguran|utang|kemiskinan|emosi|amarah|tawa|tangis|protes|cuan)|perang (tarif|dagang|harga|diskon|promo|bintang|opini|narasi|argumen|tagar|buzzer|medsos|urat syaraf|dingin|kata[- ]kata)|saling serang (opini|argumen|narasi|cuitan|komentar)|adu jotos (anggota (dpr|dprd|dewan|parlemen)|politisi)|(?:dibanjiri|kebanjiran|banjir|membanjiri) (order|orderan|diskon|promo|pujian|notif|notifikasi|air\s?mata|ingus|berita|informasi|data|inbox|email|surel|wa|whatsapp|komen|komentar|dm|like|followers?|rezeki|cuan|berkah|hadiah|bonus|kado|tawaran|pesanan|chat|ucapan|kritik|kecaman|hujatan|turis|wisatawan|penonton|pelamar|pendaftar|peserta|gol|impor|produk|barang|tekstil|beras|tka|aktivitas|serangan\s+siber|serangan\s+cyber|\bpc\b|photocards?|merch|lightstick|fancam|konten|content|update|jadwal|kerjaan|tugas)|satu\s+album\s+banjir|\bdpr\s+(?:ian|live|cream|artic|rem|regime|squad|gang|crew|member)\b|\bdream\s+perfect\s+regime\b|\b(?:carat|army|blink|nctzen|briize|shotties|engene|moa|fearnot|midzy|neverland|stay|once|reveluv|sone|exo-?l|atinys?|monbebe|insomnia)\b[^.\n]{0,60}\b(?:album|\bpc\b|photocards?|comeback|fancam|bias|lightstick)\b|\bbem\b[^.\n]{0,80}\b(?:kode|css|html|modifier|element|frontend|styling|component)\b|\b(?:jogar|main|game|killer|survivor|perk|dead\s+by\s+daylight)\b[^.\n]{0,30}\bdbd\b|\bdbd\b[^.\n]{0,30}\b(?:jogar|main|game|killer|survivor|perk)\b|\bcrowcaster\.com\b|\bR[1-9]\s+#\d+\b[^.\n]{0,60}\$\d+\.\d+|\bot[4-9]\b|\bot1[0-3]\b|member\s+kangen|pembangkit\s+listrik\s+tenaga\s+kangen|(?:kyk|kaya|kayak|seperti|ibarat)\s+(?:nunggu|menunggu\s+)?(?:orang\s+hamil|pengumuman\s+snbt|snbt|sbmptn)|\b(?:nadia\s+omara|ku\s+racuni|bujuran\s+keracunan)\b|(?:suruh|disuruh)\s+jadi\s+anjing\s+rabies|\bjam\s+aja\s+di\s*korupsi\b|(?:anjir+|anjg|wkwk+|hahaha+)\b[^.\n]{0,40}\b(?:rabies|keracunan|korupsi)\b|\b(?:rabies|keracunan|korupsi)\b[^.\n]{0,40}\b(?:wkwk+|hahaha+|cringe)\b|\bblt\b[^.\n]{0,50}(?:sandwich|grilled\s+cheese|bacon|lettuce|tomato|bread|toast|burger|deli|mayo|lunch)|(?:sandwich|grilled\s+cheese|bacon|lettuce|tomato|bread|toast|burger|deli|mayo)\b[^.\n]{0,50}\bblt\b|(hati|dada|semangat|jiwa|emosi|cemburu|amarah)[^.\n]{0,12}terbakar|tenggelam dalam|hanyut dalam|terjun (bebas )?(ke dunia|ke politik|payung)|panggung\s+terbakar|terbakar\s+(?:panggung|semangat)|tabrakan\s+(?:logika|jadwal|agenda|kepentingan|nalar|argumen|ideologi)|menabrak\s+(?:aturan|logika|nalar|hukum|undang[- ]undang|konstitusi|etika|norma)|tergelincir\s+(?:lidah|dari\s+puncak|klasemen|posisi|jabatan)|jembatan\s+cinta\s+ambruk|keracunan\s+(?:cinta|drakor|kpop|belanja|olshop|tiktok|shopee|konten)|wabah\s+(?:judi|judol|korupsi|kebencian|cinta|rindu|hoaks|kebodohan|fitnah)|racun\s+(?:shopee|tiktok|medsos|belanja|dunia)|ditembak\s+mati\s+rasa|mati\s+rasa\s+hatiku|nembak\s+wifi|begal\s+(?:rekening|saldo|kuota|data|pulsa)|pembunuhan\s+karakter|sinopsis\s+film|review\s+film|trailer\s+film|rekomendasi\s+film|adegan\s+film|nonton\s+(?:bareng|nobar|film|movie|bioskop|tv|sinetron|drakor|anime|konser|netflix|youtube|yt|fancam|trailer|teaser|video|konten|rekaman|pertandingan|bola|live|eps\b|episode|season|ch\b|chapter)|(?:lagi|mau|abis|habis|pengen|sambil|ikut|diajak)\s+nonton|nonton(?:nya)?\s+di\s+(?:bioskop|netflix|cinema|cgv|xxi|cinepolis|vidio|wetv|viu|iqiyi|bstation|youtube|yt)|tiket\s+(?:nonton|konser)|adegan\s+(?:film|sinetron|drakor)|drakor|kpop|k-pop|fancam|webtoon|anime|episode|\beps\b|chapter|concert|ditembak\s+duluan|ditembak\s+(?:sama\s+)?(?:gebetan|doi|crush|cewek|cowok|temen|teman|orang)|nembak\s+(?:gebetan|doi|crush|cewek|cowok)|curhat\s+(?:pacaran|percintaan|gebetan)|nyatain\s+perasaan|nyatakan\s+perasaan|ngedrama\s+(?:kecelakaan|tabrakan|sakit|kematian|meninggal)|drama\s+(?:kecelakaan|tabrakan)|mantan\s+rp|anak\s+rp|pacar\s+rl|@(?:ManUtd|ChelseaFC|Arsenal|LFC|realmadrid|FCBarcelona|ManCity|SpursOfficial|juventusfc|acmilan|persib|Persija_Jkt|persebayaupdate|aremafcofficial|carras\w*)\b|#(?:MUFC|CFC|AFC|LFC|GGMU|YNWA|HalaMadrid|ViscaBarca|ForzaJuve|PERSIB|PersibDay|PersijaDay|PersebayaDay|AremaDay|Bobotoh|TheJak|Bonek|Aremania)\b|\b(?:emyu(?:\s+(?:baby|bapuk|juara|pucuk|day|fc))?|munyuk|madridiot|decul|chelshit|arsenyet|king\s+indo|lord\s+(?:maguire|lingard)|tsunami\s+trofi|viking\s+persib|bobotoh\s+persib)\b|\b(?:cdrama|drachin|jdrama|dorama|thaidrama|lakorn)\b|\b(?:kim\s+ji-?won|meng\s+ziyi|xiao\s+zhan|wang\s+yibo|doctor\s+x|queen\s+of\s+tears|tigers\s+sniff\s+the\s+rose|sniff\s+the\s+rose)\b|\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\s+of\s+(?:Doctor\s+X|Tigers\s+sniff|Queen\s+of\s+Tears|Lovely\s+Runner|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b|\b(?:sid\s+bukan\s+pahlawan|superman\s+is\s+dead|pelacur\s+jalanan\s+bermahkotakan|bermahkotakan\s+duri|tutup\s+matamu\s+kawan\s+besarkan\s+hati)\b|(?:(?:gempa|tsunami|banjir|kebakaran|erupsi)[^.\n]{0,60}#(?:PERSIB|MUFC|Persija|Bobotoh))|(?:krakatau|semeru|merapi|bromo|sinabung|marapi)[^.\n]{0,30}(?:krakatau|semeru|merapi|bromo|sinabung|marapi))/i;

const SOC_LISTING_RE = /(rumah|propert\w*|tanah|kavling|ruko|rukan|kost|kosan|apartemen|villa|cluster|dagung|bengkel|gudang|kios|petak|showroom|motogarage|otomotif|motor second|mobil second|sewa mobil|rental mobil|sparepart|bengkel modifikasi|civic|avanza|brio|innova|xpander|ertiga|vario|nmax|beat\s+\d{4}|matic\s+\d{4})/i;
const SOC_LISTING_DEAL = /(dijual|mau jual|jual cepat|disewakan|disewa|menjual|menyewakan|over\s*kredit|kpr|dp\s?(nol|0)?\b|cash\s?(keras|cepat|bertahap)|nego|furnish|siap (huni|tempati|pakai|lanjut)|pajak\s+hidup|surat\s+lengkap|strategis|prime location|turun harga|ngotak|pinang|worth+|hemat\s+\d|buruan|mumpung|bonus\s+(car|cash)|cashback|payment plan|cicilan|booking fee|unit (tinggal|tersedia|ready)|hubungi (wa|whatsapp)|pre[- ]?order|ready stock|bebas request|request (warna|striping|konsep|modifikasi|custom)|modifikasi sesuai|custom (livery|striping|wrap)|garansi\b|quality check|diserahterimakan|serah terima)/i;
const SOC_SPAM_RE = /(vote for|follow\s+[\w.@-]+\s*[+.&]?\s*follow|like\s*(dan|&|\+)\s*(follow|rt)|rt\s*(dan|&|\+)\s*follow|dm\s+(untuk|di|ke)\s*(order|harga|promo|info|respon|detail|ticket|tiket)|dm\s+ke\s+@|link\s+(di|ada di)\s+bio|cek\s+(link\s+)?di\s+bio|order\s+(via|melalui|di)\s+(wa|whatsapp|dm|bio|link)|order\s+(di|via)\s+bio|s\.shopee\.co\.id|shp\.ee|tokopedia\.link|(?:diskusiin|konsultasi)\s+project\s+kamu|(?:via\s+)?(?:dm|wa|whatsapp)\s+(?:atau\s+(?:whatsapp|wa|dm)\s+)?di\s+bio|linktree|lynk\.?id|beacons\.?ai|taplink|bio\.?link|kasih\s+follow|follow\s+balik|jangan\s+lupa\s+follow|\bfyp\b|foryou|new\s+followers?|boost\s+followers?|giveaway|gifted|berhadiah|klaim\s+(hadiah|reward|bonus)|winner\s+dm|pemenang\s+(dm|di\s+(comment|komentar))|tag\s+(teman|orang|friend)|sebutkan\s+\d+\s*teman|tag\s+\d+\s*teman|(like|comment|share|follow)\s*(dan|&|\+)\s*(like|comment|share|follow|rt)|\b\d{1,2}\s*\/\s*(thread|bagian|part|lanjutan)|thread\s*\/|🧵|lanjut\s+di\s+thread|baca\s+sampai\s+habis|qris[^.\n]{0,40}order|order[^.\n]{0,40}qris|binary\s+option|robot\s+trading|signal\s+(trading|emas|crypto|kripto|saham)|rekomendasi\s+(saham|crypto|kripto)|cuan\s+tiap\s+hari|airdrop|seed\s+phrase|private\s+key|withdraw\s+(cepat|instan|kilat)|(?:\bbutuh\b|\bjasa\b|\bcair\s+cepat|\btanpa\s+bi\s+checking|\blunasi|\bhapus\s+data|\bgestun)\s+pinjol|pinjol\s+(?:cair\s+cepat|mudah\s+cair|legal\s+tanpa|bunga\s+rendah)|(?:tawaran|promo|ajakan|gabung)\s+investasi\s+bodong|\bwtb\b|\bwts\b|jasa titip|\bjastip\b|jasa war|war tiket|titip (tiket|beli)|tetap\s+cep[ae]t\s+dan\s+terkoordinasi\s+dengan\s+baik|dikawal\s+penuh\s+pemerintah|#penanganankarhutla|ngenalin\s+(?:temen|teman)\s+aku|kenalan\s+(?:yuk|dong)|cari\s+(?:jodoh|pasangan|pacar|suami|istri|kriteria)|kriteria\s*:\s*\d|cv\s+taaruf|biodata\s+taaruf|\btaaruf\b|siap\s+nikah|biro\s+jodoh|teman\s+kencan|cari\s+(?:cowok|cewek)|kriteria\s+(?:pasangan|calon|suami|istri)|tidak\s+merokok[^.\n]{0,40}tidak\s+judi|adakah\s+rekomendasi|butuh\s+rekomendasi|info\s+rekomendasi|spill\s+rekomendasi|minta\s+rekomendasi|(?:ada\s+|adakah\s+)?rekomendasi\s+(?:jasa|tempat|toko|salon|bengkel|laundry|klinik|dokter|cafe|kost|kosan)|jasa\s+(?:cleaning|kebersihan|bersih[- ]bersih|sedot\s+wc|service\s+ac|servis\s+ac|pindahan|laundry|cuci\s+sepatu|poles|makeup|mua|catering|katering|setrika|massage|pijat|joki)|cleaning\s+(?:rumah|kantor|apartment|apartemen)|bukan\s+perorangan[^.\n]{0,40}dramanya|joki\s+(?:tugas|skripsi|makalah|turnitin|kuis|ujian)|jual\s+(?:akun|follower|saldo)|sewa\s+akun|\b(?:janda|bispak|open\s*bo|michat|bokep|sange|colmek|coli|booking\s*cewek)\b|\bcrowcaster\.com\b|\bR[1-9]\s+#\d+\b[^.\n]{0,60}\$\d+\.\d+|\bot[4-9]\b|\bot1[0-3]\b|member\s+kangen|pembangkit\s+listrik\s+tenaga\s+kangen|(?:kyk|kaya|kayak|seperti|ibarat)\s+(?:nunggu|menunggu\s+)?(?:orang\s+hamil|pengumuman\s+snbt|snbt|sbmptn)|\b(?:nadia\s+omara|ku\s+racuni|bujuran\s+keracunan)\b|(?:suruh|disuruh)\s+jadi\s+anjing\s+rabies|\bjam\s+aja\s+di\s*korupsi\b|(?:anjir+|anjg|wkwk+|hahaha+)\b[^.\n]{0,40}\b(?:rabies|keracunan|korupsi)\b|\b(?:rabies|keracunan|korupsi)\b[^.\n]{0,40}\b(?:wkwk+|hahaha+|cringe)\b|ditembak\s+duluan|ditembak\s+(?:sama\s+)?(?:gebetan|doi|crush|cewek|cowok|temen|teman|orang)|nembak\s+(?:gebetan|doi|crush)|(?:ga|gak|nggak|belum|lagi\s+(?:ga|gak|nggak))\s+mau\s+pacaran|curhat\s+(?:pacaran|percintaan|gebetan)|nyatain\s+perasaan|nyatakan\s+perasaan|confess\s+(?:ke\s+)?crush|makan\s+malem\s+bareng[^.\n]{0,50}(?:didn['’]?t\s+want|feel\s+some\s+type|perasaan|baper)|obrolan[^.\n]{0,40}minta\s+maaf[^.\n]{0,40}pacaran|mantan\s+rp|anak\s+rp|pacar\s+rl|ngedrama\s+(?:kecelakaan|tabrakan|sakit|meninggal)|(?:setaun|setahun|\d+\s*(?:tahun|thn|bln|bulan))\s+pacaran[^.\n]{0,40}(?:putusin|diputusin|putus)|\b(?:mau\s+)?(?:gw|gua|gue|aku)\s+putusin\b)/i;

const SOC_NONLATIN_RE = /[\u0E00-\u0E7F\u0E80-\u0EFF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u10A0-\u10FF]/g;
const SOC_SCRIPT_RES = {
  kana: /[぀-ヿ]/g,
  hangul: /[가-힯ᄀ-ᅟ]/g,
  thai: /[฀-๿]/g,
  arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  devanagari: /[ऀ-ॿ]/g,
  armenian: /[԰-֏]/g,
  hanzi: /[㐀-䶿一-鿿]/g,
};
const SOC_SCRIPT_MIN = { kana: 3, hangul: 3, thai: 4, arabic: 4, cyrillic: 4, devanagari: 4, armenian: 4, hanzi: 3 };

function socNonLatin(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ');
  for (const k in SOC_SCRIPT_RES) {
    if ((s.match(SOC_SCRIPT_RES[k]) || []).length >= SOC_SCRIPT_MIN[k]) return true;
  }
  const nl = (s.match(SOC_NONLATIN_RE) || []).length;
  const lat = (s.match(/[A-Za-zÀ-ɏ]/g) || []).length;
  return nl >= 20 && nl > lat;
}

const SOC_VI_RE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/g;
function socVi(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ');
  const vi = (s.match(SOC_VI_RE) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return (vi >= 15 && vi * 4 >= lat) || (vi >= 8 && vi * 3 >= lat);
}

function socHashJunk(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ');
  const tags = s.match(/#[\p{L}\p{N}_]+/gu) || [];
  const n = tags.length + (s.match(/＃/g) || []).length;
  const cashtags = (s.match(/\$[\p{L}\p{N}]{2,}/gu) || []).length;
  if (n > 10) return true;
  if (cashtags >= 3 && /\b(crypto|kripto|bitcoin|btc|ethereum|airdrop|trading|cuan|investasi|signal|token|wallet)\b/i.test(s)) return true;
  const chars = tags.reduce((x, h) => x + h.length, 0);
  const ratio = chars / Math.max(1, s.length);
  if (n >= 8 && ratio > 0.28) return true;
  if (n >= 5 && s.length <= 80 && ratio > 0.30) return true;
  return s.length > 60 && ratio > 0.4;
}

function astroturfSig(t) {
  return String(t || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w]+/g, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

const { franc } = require('franc');
const SOC_LANG_OK = new Set(['ind', 'zlm', 'eng', 'und', 'sun', 'min', 'jav', 'mad', 'ban', 'bug', 'mak', 'ace']);
const SOC_FOREIGN_WORDS_RE = /\b(?:tenho|jogar|jugar|voltar|estoy|avec|pour|dans|nicht|quoi|merci|obrigado|vuelta|habra|habrá|dado|povo|assusta|infidelite|infidélité|nouveau|nouvelle|variant\s+du|is\s+het|gaat\s+het|hebben\s+we|het\s+kabinet|uit\s+het|staat\s+op\s+vallen|gevallen|klappen|gestapt|nog\s+niet|nog\s+een|vvd|d66|pvv|tweede\s+kamer|niet\s+gevallen|zijn\s+er|waarom|wanneer|misschien|eigenlijk|gewoon|altijd|nooit|iemand|niemand|echt\s+niet|por\s+que|porque|pero|como\s+estas|tambien|también|mucho|todos|tiene|tienen|hacer|puede|pueden|cuando|donde|dónde|quien|quién|estos|estas|nosotros|ustedes|ellos|ellas|muito|voce|você|nao|não|entao|então|tambem|também|ainda|agora|sempre|nunca|ninguem|ninguém|alguem|alguém|c'est|qu'est|est-ce|sont|mais|plus|tout|tous|faire|peut|comme|cette|votre|notre|leurs|aussi|meme|même|jamais|toujours|personne|quelqu'un|aber|oder|wenn|weil|kein|keine|haben|werden|wurde|können|müssen|sagen|machen|dieser|diese|dieses|immer|wieder|heute|gestern|morgen|ang\s+mga|mga\s+tao|naman|talaga|bakit|paano|ganito|ganyan|kasi|para\s+sa|hindi\s+ko|wala\s+na|meron)\b/i;
const SOC_FOREIGN_DIACRITIC_RE = /[¿¡ñÑçÇßãõÃÕåøæÅØÆłńśźżŁŃŚŹŻčřšžČŘŠŽğışĞİŞ]|[áéíóúàèìòùâêîôûäöüëïÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄÖÜËÏ]/;
const SOC_ID_UNAMBIGUOUS_RE = /\b(?:yang|yg|untuk|utk|dengan|dgn|sudah|udah|udh|belum|blm|tidak|bukan|ga|gak|nggak|engga|kagak|gue|gw|gua|aku|kami|kita|warga|orang|org|rumah|rmh|jalan|jln|banget|bgt|sih|dong|deh|kok|jir|anjir|njir|bjir|wkwk\w*|jujurly|kalo|kalau|karena|krn|tapi|tp|terus|trs|jadi|jd|masih|msh|lagi|lg|baru|mau|pengen|bisa|bikin|pakai|pake|kemarin|besok)\b/i;
const SOC_ID_AMBIGUOUS_RE = /\b(?:dan|di|ke|dari|ini|itu|atau|ada|sama|sm|buat|cuma|cm|tadi|barusan|hari|pagi|siang|sore|malam|jam|lo|lu|lah|kan|kah|tuh|nih)\b/i;
const SOC_ID_MARKER_RE = /\b(?:yang|yg|dan|di|ke|dari|ini|itu|untuk|dengan|atau|sudah|udah|udh|belum|blm|tidak|bukan|ga|gak|nggak|engga|kagak|gue|gw|gua|aku|lo|lu|kami|kita|warga|orang|org|rumah|rmh|jalan|jln|banget|bgt|sih|dong|deh|kok|lah|kan|kah|tuh|nih|jir|anjir|njir|bjir|wkwk|jujurly|kalo|kalau|karena|krn|tapi|tp|terus|trs|jadi|jd|masih|msh|lagi|lg|baru|mau|pengen|bisa|ada|sama|sm|buat|bikin|pakai|pake|cuma|cm|tadi|barusan|kemarin|besok|hari|pagi|siang|sore|malam|jam)\b/i;
function socForeignLang(t) {
  const s = String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ').trim();
  const idUnambiguousMatches = s.match(new RegExp(SOC_ID_UNAMBIGUOUS_RE.source, 'gi')) || [];
  const hasLocalEntity = SOC_LOCAL_RE.test(s);
  const hasIdContext = hasLocalEntity || idUnambiguousMatches.length > 0;
  if (SOC_FOREIGN_WORDS_RE.test(s) && !hasLocalEntity && idUnambiguousMatches.length < 2) return true;
  const sNoLoan = s.replace(/\b(?:caf[eé]s?|r[eé]sum[eé]s?|na[iï]ve|fianc[eé]e?s?|clich[eé]s?|d[eé]j[aà]\s*vu|voil[aà]|ol[eé]|[\u00fcU]ber)\b/gi, ' ');
  if (SOC_FOREIGN_DIACRITIC_RE.test(sNoLoan) && !hasLocalEntity && idUnambiguousMatches.length < 2) return true;

  if (hasIdContext) return false;
  if (s.length < 20) return false;
  const lang = franc(s);
  return !!lang && !SOC_LANG_OK.has(lang);
}

const SOC_FOREIGN_RE = /\b(amerika|united states|\busa\b|americans?|american|british|canadian|australian|japanese|chinese|korean|french|german|russian|indian|ukrainian|israeli|palestinian|malaysian|singaporean|filipino|vietnamese|brazilian|mexican|european|texas|california|new york|brasil|brazil|filipina|thailand|malaysia|korea|jepang|japan|tiongkok|china|inggris|britain|prancis|perancis|paris|france|jerman|germany|australia|india|pakistan|iran|israel|palestina|palestine|ukraina|ukraine|rusia|russia|gaza|turki|turkey|meksiko|mexico|kanada|canada|vietnam|chile|argentina|spanyol|spain|portugal|italia|italy|belanda|netherlands|den haag|s-gravenhage|tweede kamer|eerste kamer|vvd|cda|d66|pvv|fvd|nsc|gl-pvda|groenlinks|pvda|nederland|nederlands|holland|amsterdam|rotterdam|utrecht|eindhoven|groningen|kabinet rutte|kabinet schoof|dick schoof|geert wilders|swiss|swedia|sweden|norwegia|norway|denmark|yunani|greece|eropa|europe|nepal|london|oyo|osun|nigeria|afrika|trump|poland|polandia|polonia|krakow|warsaw|warszawa|lublin|czechia|ceko|prague|praha|austria|vienna|wina|finland|finlandia|helsinki|singapura|singapore|hong kong|taipei|tokyo|seoul|beijing|manila|bangkok|hanoi|kualalumpur|kathmandu|moskwa|moscow|berlin|rome|roma|madrid|amsterdam|brussels|zurich|stockholm|oslo|copenhagen|dublin|budapest|bucharest|sofia|belgrade|zagreb|vilnius|riga|tallinn|minsk|kiev|kyiv|istanbul|ankara|tehran|baghdad|beirut|riyadh|cairo|tunis|algiers|rabat|tripoli|khartoum|nairobi|kampala|kigali|lusaka|harare|pretoria|mogadishu|bamako|dakar|abuja|lagos|accra|kinshasa|sao paulo|rio de janeiro|brasilia|buenos aires|bogota|caracas|la paz|asuncion|montevideo|kingston|havana|santo domingo|paramaribo|managua|tegucigalpa|san salvador|san jose|guatemala city|mexico city|sucre|suriah|syria|irak|iraq|mesir|egypt|libya|libia|maroko|morocco|aljazair|algeria|tunisia|sudan|ethiopia|kenya|ghana|myanmar|kamboja|cambodia|laos|srilanka|sri lanka|bangladesh|lebanon|yordania|jordan|yaman|yemen|oman|qatar|uea|hungaria|hungary|rumania|romania|bulgaria|serbia|kroasia|croatia|slowakia|slovakia|slovenia|belgia|belgium|irlandia|ireland|estonia|latvia|lithuania|belarus|mongolia|maladewa|maldives|timor leste|selandia baru|new zealand|kuba|cuba|jamaika|jamaica|haiti|nikaragua|kosta rika|costa rica|kolombia|colombia|venezuela|bolivia|ekuador|ecuador|peru|paraguay|uruguay|congo|rwanda|uganda|tanzania|zambia|zimbabwe|mozambique|angola|namibia|botswana|lesotho|madagascar|mauritius|somalia|eritrea|djibouti|afghanistan|bhutan|brunei|albania|armenia|azerbaijan|cyprus|iceland|kosovo|luxembourg|malta|moldova|montenegro|san marino|vatikan|vatican|monako|monaco|georgia|jordan|panama|senegal|cameroon|gambia|guinea|sierra leone|liberia|mauritania|burkina faso|shah alam|selangor|bukit jelutong|subang jaya|petaling jaya|putrajaya|klang|penang|johor bahru|british columbia|tahsis|democrats|republicans|lebuhraya|plusline|llmtrafik|korang|macam ni|banjir tak|banjir ke|kesiannya|memandu|tanpa halangan banjir|terowong smart|m'sia|msia|sejuk beku|bekalan makanan|berbaki|penyokong|rombak kabinet|bubarkan parlimen|bubar parlimen|parlimen|timbalan perdana menteri|pakatan harapan|perikatan nasional|barisan nasional|umno|menteri besar|ketua menteri|dewan rakyat|dewan negara|kerajaan perpaduan|kerajaan madani|malaysia madani|varian baharu|baharu|dikesan|sejauh mana bahayanya|siakap keli|thesiakapkeli|banjir kilat|jabatan bomba|polis diraja|kawasan terjejas|hospital kerajaan|kementerian kesihatan)\b/i;
const SOC_LOCAL_RE = /(indonesia|\bwni\b|jakarta|jabar|jateng|jatim|jawa|sumatera|sumatra|kalimantan|sulawesi|papua|bali\b|aceh|riau|banten|bekasi|bogor|depok|tangerang|bandung|surabaya|medan|makassar|semarang|yogya|bpbd|bnpb|bmkg|polres|polda|polsek|kodim|damkar|pemkot|pemkab|kabupaten|provinsi|prabowo|gibran|\bdpr\b|dprd|kapolri|polri)/i;

const SOC_TOPICS = [
  {
    id: 'demo',
    local: true,
    pos: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa|\b(?:ber|men|di)?demo\b|protes|mogok|kerusuhan|bentrok|pemogokan|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day|\borasi\b|\bricuh\b|gas air mata|water cannon|buruh mogok|\bkspi\b|\bfspi\b|aksi buruh|\breformasi\b|turun ke jalan|turun ke aspal|\bmay day\b|long march|barikade|tuntutan mahasiswa|(?:gelar|menggelar|melakukan)\s+aksi|aksi\s+(?:tolak|menolak|tuntut|menuntut|mahasiswa|buruh|damai|bela|bem|rakyat)|(?:gerakan|aliansi|elemen|korps|seruan|peserta|massa)\s+(?:aksi|mahasiswa|buruh)|mahasiswa\s+(?:turun|bergerak|melawan|berdemo|unjuk\s+rasa|orasi|dikepung|diculik|ditangkap)|(?:kampus|gedung|jalan)\s+dikepung|(?:kawan[- ]kawan|mahasiswa|peserta\s+aksi)\s+(?:diduga\s+)?diculik|(?:logistik|bantuan\s+medis)\s+(?:dihalangi|tertahan|dicegat)|(?:jogja|surabaya|surakarta|jakarta|bandung|semarang|gejayan|rakyat)\s+memanggil|(?:ga|gak|tidak|kurang)\s+kondusif|brutalitas\s+aparat|tindakan\s+represif|(?:menyuarakan\s+keadilan|memperjuangkan\s+kebenaran)\b(?=[^.!?\n]{0,80}\b(?:mahasiswa|buruh|rakyat|massa|aparat|polisi|dpr|istana|kampus|jalan|demo|aksi|orasi|represif|tuntutan|kawan)\b)|\b(?:mahasiswa|buruh|rakyat|massa|aparat|polisi|dpr|istana|kampus|jalan|demo|aksi|orasi|represif|tuntutan|kawan)\b[^.!?\n]{0,80}\b(?:menyuarakan\s+keadilan|memperjuangkan\s+kebenaran)|rakyat\s+bersatu(?:\s+tak\s+bisa\s+dikalahkan)?|hidup\s+mahasiswa|hidup\s+rakyat|panjang\s+umur\s+perjuangan|\bnon\s+serviam\b)/i,
    strong: /(unjuk rasa|demonstrasi|demonstran|pengunjuk rasa|aksi massa|protes|mogok|kerusuhan|bentrok|pemogokan|women'?s\s+march|international\s+women'?s\s+day|hari\s+buruh|buruh\s+sedunia|labour\s+day|labor\s+day|(?:gelar|menggelar)\s+aksi\s+(?:tolak|menolak|tuntut|menuntut|mahasiswa|buruh|massa|bem)|aksi\s+(?:tolak|menolak|tuntut|menuntut)\s+(?:kebijakan|ruu|uu|kenaikan)|kampus\s+dikepung|mahasiswa\s+dikepung|kawan\s+diculik|peserta\s+aksi\s+diculik|ditembaki\s+gas\s+air\s+mata|brutalitas\s+aparat|(?:jogja|surabaya|surakarta|jakarta|bandung|semarang|gejayan|rakyat)\s+memanggil)/i,
    ctx: /(tuntut|tolak|mahasiswa|\bbem\b|buruh|ojol|\bdpr\b|dprd|gedung|polisi|aparat|gas air mata|\baksi\b|\bmassa\b|\borasi\b|turun ke jalan|turun ke aspal|spanduk|\bricuh\b|bentrok|rusuh|ditangkap|diamankan|bubarkan|barikade|molotov|water cannon|kapolda|kapolres|\breformasi\b|pemerintah|istana|patung kuda|\bmarch\b|aksi damai|long march|protes|mogok|kerusuhan|pemogokan|kondusif|mencekam|kampus|logistik|dikepung|diculik|keadilan|kebenaran|perjuangan|melawan|represif|memanggil)/i,
    neg: /(demo (lagu|musik|reel|reels|app|apps|aplikasi|akun|produk|plane|game|beat|tape|masak|memasak|cooking|vokal|record|rekaman|day|link|version|ui|web|website|bot|trading)|free demo|live demo|cooking demo|demonstrasi (produk|alat|masak|memasak|fitur)|happy\s+(labor|labour|international\s+women'?s)\s+day|selamat\s+(hari buruh|hari perempuan|international women'?s day)|\bdemo\b.{0,20}#(music|musik|beat)|bagi[- ]?bagi\s+(?:gratis|kopi|americano|minuman|makanan|voucher|hadiah))/i,
    x: ['(unjuk rasa OR demonstrasi OR "aksi massa" OR demonstran OR "mahasiswa demo") -filter:replies',
      'demo (mahasiswa OR buruh OR ojol OR DPR OR tuntutan OR ricuh OR polisi OR dikepung) -filter:replies'],
    th: ['demo', 'unjuk rasa', 'aksi massa', 'demo hari ini', 'demo mahasiswa', 'demonstrasi', 'aksi mahasiswa', 'jogja memanggil', 'surabaya memanggil', '#unjukrasa'],
  },
  {
    id: 'kebakaran',
    local: true,
    pos: /(kebakaran|terbakar|kobaran api|si jago merah|dilalap api|ludes dilalap|\bdamkar\b)/i,
    neg: /(kebakaran (hutan|lahan)|karhutla|kebakaran (harga|promo|diskon|obral|sale|murah|gila|meriah|jagoan|gaib|mangling|total)|(?:ihsg|saham|portofolio|porto|market|bursa|kripto|crypto)\s+kebakaran|kebakaran\s+\+?\d|harga (kebakaran|panas|terbakar)|(terbakar|kebakaran)[^.\n]{0,20}(nasi|roti|ayam|makanan|kuliner|resep|memasak|cooking|wajan|panci|steak|bakso|mie\b)|kebakaran\s+jenggot|tersulut\s+api\s+(?:amarah|cemburu|emosi|dendam)|terbakar\s+(?:api\s+)?(?:amarah|cemburu|emosi|semangat|rindu|api\s+asmara)|(?:membakar|sulut)\s+(?:semangat|jiwa|emosi|amarah|nyali|dada|panggung|duit|uang)|bakar\s+(?:duit|uang|kalori|lemak)|strategi\s+film|kolaborasi\s+dengan\s+damkar)/i,
    x: ['(kebakaran OR "si jago merah" OR "ludes terbakar" OR damkar) -filter:replies'],
    th: ['kebakaran hari ini', 'kebakaran', 'damkar', 'terbakar', 'kobaran api', 'dilalap api', '#kebakaran'],
  },
  {
    id: 'karhutla',
    local: true,
    pos: /(karhutla|kebakaran (hutan|lahan)|titik panas|hotspot|kabut asap|\basap\b|sipongi)/i,
    strong: /(karhutla|kebakaran (hutan|lahan)|kabut asap)/i,
    ctx: /(hutan|lahan|karhutla|kebakaran|riau|sumatera|kalimantan|papua|jambi|sumsel)/i,
    neg: /\b(?:wifi|wi-fi|tethering|phone|fone|hp|ponsel|kuota|paket\s+data|download|connect|password|nyalain|minta|pakai|pake|use\s+a|using\s+a)\b[^.\n]{0,30}\bhotspot\b|\bhotspot\b[^.\n]{0,30}\b(?:wifi|wi-fi|tethering|phone|fone|hp|ponsel|kuota|paket\s+data|download|gta|game|connect|password)\b/i,
    x: ['(karhutla OR "kebakaran hutan" OR "kebakaran lahan" OR "kabut asap" OR "titik panas" OR hotspot) -filter:replies'],
    th: ['karhutla', 'kebakaran hutan', 'kabut asap', 'kebakaran lahan', 'titik panas'],
  },
  {
    id: 'banjir',
    local: true,
    pos: /(?:\bbanjir\b(?!\s*(?:serangan|siber|cyber|orderan|hadiah|promo|diskon|bonus|cuan|kritik|hujatan|komentar|aduan|laporan|pujian|ucapan|impor|produk|pemudik|turis|wisatawan|penonton|pelamar|pendaftar|peserta|air mata|gol|konten|content|update|jadwal|kerjaan|tugas))\b|banjir bandang|banjir rob|banjir lahar|banjir lumpur|\bkebanjiran\b|longsor|tanggul\b[^.!?\n]{0,25}\bjebol|air meluap|genangan|hujan deras|air bah|(?:air(?:\s+(?:hujan|kali|sungai|selokan|got))?)\s+(?:sudah\s+|udah\s+|mulai\s+|lagi\s+)?masuk\s+(?:ke\s+)?(?:rumah|kamar|teras|kosan|kontrakan|ruko|warga)|(?:air|banjir)\s+(?:sudah\s+|udah\s+|mulai\s+)?se(?:mata\s+kaki|betis|lutut|pinggang|dada))/i,
    strong: /(?:banjir\s+bandang|banjir\s+rob|tanggul\b[^.!?\n]{0,25}\bjebol|tanah\s+longsor|longsoran\s+tanah|air\s+bah|sungai\s+meluap|banjir\s+merendam|ketinggian\s+air|genangan\s+air|banjir\s+(?:melanda|merendam|parah|kembali|menerjang|mengepung|menggenangi|tinggi|luap)|kebanjiran\s+parah|terendam\s+banjir|(?:air(?:\s+(?:hujan|kali|sungai|selokan|got))?)\s+(?:sudah\s+|udah\s+|mulai\s+|lagi\s+)?masuk\s+(?:ke\s+)?(?:rumah|kamar|teras|kosan|kontrakan|ruko|warga)|(?:air|banjir)\s+(?:sudah\s+|udah\s+|mulai\s+)?se(?:mata\s+kaki|betis|lutut|pinggang|dada))/i,
    ctx: /(?:hujan|deras|air|sungai|tanggul|kali|drainase|pemukiman|rumah|warga|mengungsi|evakuasi|ketinggian|meter|sentimeter|\bcm\b|terendam|merendam|luapan|bpbd|bnpb|damkar|pompa|waduk|bendungan|pesisir|pasang|melanda|parah|kembali|menerjang|mengepung|menggenangi|masuk\s+rumah|berita|dulu|sering|nggak\s+sih|tidak\s+sih|genangan)/i,
    neg: /(?:dibanjiri|membanjiri)|(?:banjir|kebanjiran)\s+(?:serangan|siber|cyber|orderan|hadiah|promo|diskon|bonus|cuan|kritik|hujatan|komentar|aduan|laporan|pujian|ucapan|impor|produk|pemudik|turis|wisatawan|penonton|pelamar|pendaftar|peserta|air mata|gol|darah|konten|content|update|jadwal|kerjaan|tugas)|(?:rumah|tanah|ruko|kavling|cluster|hunian|perumahan|residence|villa|apartemen|kost|kontrakan|sewa|dijual|over\s*kredit)[^.!?\n]{0,40}\b(?:bebas|anti|aman|tanpa)\s+banjir|\blongsor\s+(?:suara|kursi|dukungan|koalisi)\b/i,
    x: ['(banjir OR longsor OR "air meluap" OR "tanggul jebol" OR "banjir bandang" OR "air bah") -filter:replies'],
    th: ['banjir hari ini', 'banjir', 'banjir bandang', 'longsor', 'tanggul jebol', 'air meluap', '#banjir'],
  },
  {
    id: 'gempa',
    local: true,
    pos: /(gempa\s+bumi|gempa\s+tektonik|gempa\s+vulkanik|gempa\s+susulan|\bgempa\b|tsunami|magnitudo|erupsi|gunung\s+meletus|letusan|awan panas|guguran lava|lahar (?:dingin|hujan)|guncangan|megathrust|hujan abu|semburan abu)/i,
    neg: /(blue|blauwe)\s+tsunami|tsunami\s+(biru|merah|politik|protes|suara|pemilu|dukungan|saham|cuan|phk|vonis|anggaran|impor|trofi|piala|gol|konten)|gempa\s+(?:politik|kabinet|pasar|saham|industri|susunan|hati|rasa|jantung|batin|jiwa|sukma|lokal)|baby\s+gempa|boboiboy(?:\s+gempa)?|baju\s+gempa|kaos\s+gempa|goyang\s+gempa|joget\s+gempa|senam\s+gempa|guncangan\s+(?:politik|kabinet|ekonomi|jiwa|batin)|mengguncang\s+(?:jagat|dunia|medsos|panggung|publik|politik|parlemen|netizen|stadion|konser)|meletus\s+(?:balon|ban|perang|konflik|kerusuhan|tawa|tangis|amarah|emosi|bisul)|balon(?:ku)?\s+(?:ada\s+lima\s+)?meletus|lahar\s+(?:asmara|cinta|rindu|nafsu)|badai\s+(?:krisis|resesi|phk|inflasi|keuangan|kebangkrutan|pemecatan|kehidupan|asmara|pasti berlalu)|angin\s+segar\s+(?:bagi|untuk|ekonomi|investor|industri|pekerja|petani)/i,
    strong: /(gempa\s+bumi|gempa\s+tektonik|gempa\s+vulkanik|gempa\s+susulan|\bgempa\s+di\s+[A-Za-z]|magnitudo|\bm\s*\d+(?:[.,]\d+)?\b|\bmag(?:nitudo)?\s*[:=]?\s*\d+(?:[.,]\d+)?\b|\b\d+[.,]\d+\s*(?:sr|mag|magnitudo)\b|pusat\s+gempa|skala\s+richter|(?:kedalaman|kedlmn)\s*[:=]?\s*\d+\s*km|(?:terasa|dirasakan|kerasa)\s+(?:di|kencang|kuat|warga)|guncangan\s+gempa|getaran\s+gempa|erupsi|letusan|gunung\s+meletus|awan\s+panas|hujan\s+abu|lahar\s+(?:dingin|hujan))/i,
    ctx: /(earthquake|megathrust|gelombang\s+pasang|air\s+bah|pesisir|tepi\s+laut|palung|bmkg|bnpb|bpbd|pvmbg|magma|vulkanik|gunung|kawah|pos\s+pengamatan|status (?:awas|siaga|waspada)|tsunami|guncangan|getaran|bergetar|terasa|dirasakan|kerasa|kedalaman|kedlmn|episentrum|skala\s+richter|richter|\bsr\b|\bm\s*\d+(?:[.,]\d+)?\b|\bmag(?:nitudo)?\s*[:=]?\s*\d+(?:[.,]\d+)?\b|mmi|susulan|roboh|retak|rusak|panik|berhamburan|keluar\s+rumah|hoaks|hoax|tidak\s+ada\s+gempa)/i,
    x: ['(gempa OR tsunami OR magnitudo OR erupsi OR "gunung meletus" OR "awan panas" OR "hujan abu") -filter:replies'],
    th: ['gempa barusan', 'gempa', 'gempa bumi', 'erupsi', 'gunung meletus', 'awan panas', 'bmkg gempa', '#gempa'],
  },
  {
    id: 'badai',
    local: true,
    pos: /(badai|siklon|puting beliung|angin kencang|badai petir|angin ribut|gelombang pasang|bibit siklon|hujan ekstrem|cuaca ekstrem)/i,
    neg: /badai pasti berlalu|badai (asmara|cinta|kehidupan|hidup|rumah tangga|ekonomi|cuan|rezeki|politik|pemilu|ujian|cobaan|cedera|kritik|protes|kecaman|hujatan|penolakan|isu|gosip|kontroversi|salju)|(?:cantik|rambut|kece|gaya|tampilan)\s+badai|game badai|skin badai/i,
    strong: /(puting beliung|siklon tropis|bibit siklon|badai petir|angin ribut|angin kencang|hujan ekstrem|peringatan\s+(?:dini\s+)?(?:cuaca\s+ekstrem|hujan\s+ekstrem))/i,
    ctx: /(angin|hujan|bmkg|bnpb|bpbd|atap|pohon|rusak|terjang|menerjang|hantam|menghantam|porak[- ]poranda|terbang|roboh|tumbang|nelayan|gelombang|laut|pesisir|waspada|peringatan|terbawa angin|berhamburan|beterbangan|ekstrem)/i,
    x: ['("puting beliung" OR "angin kencang" OR "siklon tropis" OR badai OR "hujan ekstrem") -filter:replies'],
    th: ['puting beliung', 'angin kencang', 'siklon tropis', 'badai', 'cuaca ekstrem', 'hujan ekstrem'],
  },
  {
    id: 'kecelakaan',
    local: true,
    pos: /(kecelakaan|tabrakan|tabrak lari|kapal (tenggelam|karam)|pesawat jatuh|bus terguling|truk terguling|kereta anjlok|ledakan)/i,
    neg: /(ledakan (penduduk|jumlah|kasus|order|orders|promo|penjualan|chat|emoji|tawa|tangis|debat|lagu|musik|harga|bonus|like|komentar|followers?|data|traffic|trafik|inflasi|daya beli|pengangguran|utang|kemiskinan|emosi|amarah|kemarahan|protes|cuan|popularitas)|meledak\s+(?:di\s+pasaran|kasusnya|tawanya|tangisnya)|(?:harga|tarif|penduduk|kasus|order)\b[^.\n]{0,25}(?:meledak|ledakan)|tabrakan (pendapat|argumen|prinsip|debat|pemikiran|jadwal|acara|event|konser|libur|ujian|meeting|praktik|praktikum|kepentingan)|(?:ihsg|saham|rupiah|kurs|harga|suara)\s+(?:ambruk|anjlok|runtuh)|(jadwal|acara|event|konser|libur|ujian|meeting|praktik)[^.\n]{0,15}tabrakan|kecelakaan (cinta|asmara)|(?:ngedrama|drama|pura[- ]?pura|alasan|bohong|settingan)\s+(?:kecelakaan|tabrakan)|(?:kecelakaan|tabrakan)\s+(?:boongan|bohong[- ]bohongan|palsu|drama|settingan)|(?<=(?:kecelakaan|tabrakan|tertabrak|tertabrakan|tabrak lari)[^.\n]{0,200})(?:grand\s*prix|grandprix|formula\s*1|\bf1\b|kualifikasi|qualifying|sprint\s+race|pole\s+position|podium|parc\s*ferme|grid\s+(?:start|position)|start\s+grid|safety\s*car|safetycar|red\s+flag|pit\s+(?:stop|lane)|push-?lap|out-?lap|drs\s*zone|ers\s*zone|\bdrs\b|\bers\b|oversteer|understeer|lock-?up|downforce|aerodinamis|steering\s+wheel|cockpit|\bsirkuit\b|scuderia|red\s+bull(?:\s+racing)?|mercedes-amg|aston\s+martin|alpine\s+f1|haas\s+f1|racing\s+bulls|sauber|cadillac\s+f1|\bmclaren\b|balap\s+(?:motor|mobil|formula|f1|grup))|(?:grand\s*prix|grandprix|formula\s*1|\bf1\b|kualifikasi|qualifying|sprint\s+race|pole\s+position|podium|parc\s*ferme|grid\s+(?:start|position)|start\s+grid|safety\s*car|safetycar|red\s+flag|pit\s+(?:stop|lane)|push-?lap|out-?lap|drs\s*zone|ers\s*zone|\bdrs\b|\bers\b|oversteer|understeer|lock-?up|downforce|aerodinamis|steering\s+wheel|cockpit|\bsirkuit\b|scuderia|red\s+bull(?:\s+racing)?|mercedes-amg|aston\s+martin|alpine\s+f1|haas\s+f1|racing\s+bulls|sauber|cadillac\s+f1|\bmclaren\b|balap\s+(?:motor|mobil|formula|f1|grup))(?=[^.\n]{0,200}(?:kecelakaan|tabrakan|tertabrak|tertabrakan|tabrak lari)))/i,
    x: ['(kecelakaan OR "tabrak lari" OR "bus terguling" OR "kapal tenggelam" OR "truk terguling" OR "kereta anjlok" OR "pesawat jatuh" OR "kapal karam" OR tabrakan OR ledakan) -filter:replies'],
    th: ['kecelakaan hari ini', 'kecelakaan', 'kecelakaan lalu lintas', 'truk terguling', 'tabrakan', 'bus terguling', 'kereta anjlok', 'kapal tenggelam'],
  },
  {
    id: 'penembakan',
    local: true,
    pos: /(penembakan|ditembak|baku tembak|tertembak|terkena tembakan|berondong tembakan)/i,
    strong: /(penembakan|baku tembak|tertembak peluru|ditembak mati|ditembak polisi|korban penembakan|senjata api|didor timah panas|berondong tembakan)/i,
    ctx: /(polisi|polres|polda|polsek|tni|aparat|senjata|senpi|peluru|pelaku|korban|tewas|luka|kritis|darah|otk|kkb|begal|rampok|eksekusi|didor|timah panas|tkp|senapan|pistol|amunisi|selongsong|proyektil)/i,
    neg: /(ditembak\s+(?:hati|cinta|asmara|batin|panah|tatapan|duluan|gebetan|doi|cewek|cowok|temen|teman|orang|crush|mati\s+rasa)|mati\s+rasa\s+hatiku|(?:bikin\s+)?sim\s+nembak|nembak\s+(?:sim|nilai|wifi|sinyal|harga|jawaban|soal|gawang)|tembakan\s+ke\s+gawang|(?:ditembak|nembak|tertembak)[^.\n]{0,35}(?:pacaran|pacar|gebetan|doi|jadian|crush|confess|baper|pdkt|kencan|dating|tinder|bumble|dinner|makan malem|makan malam|perasaan|nyatain|nyatakan|naksir|salting)|(?:pacaran|pacar|gebetan|doi|jadian|crush|pdkt|kencan|dating|salting)[^.\n]{0,35}(?:ditembak|nembak|tertembak))/i,
    x: ['(penembakan OR "baku tembak" OR "ditembak polisi" OR "korban penembakan" OR "tertembak peluru") -filter:replies'],
    th: ['penembakan', 'baku tembak', 'ditembak polisi', 'tertembak peluru', 'korban penembakan'],
  },
  {
    id: 'pencurian',
    local: true,
    pos: /(pencurian|curanmor|begal|perampokan|jambret|dirampok|kemalingan|maling|pencuri)/i,
    strong: /(?:curanmor|pencurian\s+motor|pencurian\s+mobil|pencurian\s+dengan\s+pemberatan|perampokan|kemalingan|pencuri\s+(?:masuk|tertangkap|terekam)|maling\s+(?:motor|ayam|rumah|tertangkap|dihakimi|terekam|beraksi))/i,
    ctx: /(?:motor|mobil|hp|ponsel|uang|duit|barang|rumah|toko|helm|ternak|emas|perhiasan|laptop|sepeda|korban|pelaku|tertangkap|tuntutan|dihakimi|warga|polisi|cctv|kehilangan|hilang|lapor|beraksi|terekam)/i,
    neg: /(?:(?:wajah|muka|tampang|paras|vibes?|kelakuan|gaya|tipe|penampilan|potongan|tengil)(?:nya)?\s+maling|\bmaling\s+(?:banget|abis|amat)\b|(?:pencuri|maling|rampok|begal)[^.\n]{0,15}(?:hati|cinta|perhatian|senyum|pandangan)|(?:hati|cinta|perhatian|senyum)[^.\n]{0,15}(?:dicuri|dirampok|dibegal)|curi\s+poin|mencuri\s+poin|mencuri\s+start|curi\s+start|begal\s+(?:rekening|saldo|pulsa|data|politik|partai|konstitusi))/i,
    x: ['(pencurian OR curanmor OR begal OR perampokan OR jambret) -filter:replies'],
    th: ['pencurian', 'curanmor', 'begal', 'perampokan', 'jambret', 'dirampok', 'kemalingan'],
  },
  {
    id: 'penangkapan',
    local: true,
    pos: /(penangkapan|ditangkap|diamankan|\bott\b|razia|penahanan|buron|tersangka)/i,
    ctx: /(polisi|polres|polda|polsek|\bkpk\b|kejaksaan|\bbnn\b|densus|petugas|aparat|tersangka|pelaku|buron)/i,
    x: ['(penangkapan OR ditangkap OR OTT) (polisi OR KPK OR Densus OR tersangka) -filter:replies'],
    th: ['penangkapan', 'ditangkap polisi', 'ditangkap', 'diamankan', 'OTT', 'Densus'],
  },
  {
    id: 'phk',
    pos: /(\bphk\b|pemutusan hubungan kerja|dirumahkan|pabrik tutup)/i,
    x: ['(PHK OR "pemutusan hubungan kerja" OR dirumahkan OR "pabrik tutup") -filter:replies'],
    th: ['PHK', 'pemutusan hubungan kerja', 'dirumahkan', 'pabrik tutup'],
  },
  {
    id: 'rupiah',
    pos: /(rupiah|kurs dolar|kurs dollar|nilai tukar)/i,
    x: ['(rupiah OR "kurs dolar" OR "nilai tukar") -filter:replies'],
    th: ['rupiah', 'kurs dollar', 'dollar naik', 'kurs dolar', 'nilai tukar'],
  },
  {
    id: 'ihsg',
    pos: /(\bihsg\b|trading halt|bursa efek|\bidx\b)/i,
    x: ['(IHSG OR "trading halt" OR "bursa efek" OR IDX) -filter:replies'],
    th: ['IHSG', 'bursa efek', 'trading halt', 'IDX'],
  },
  {
    id: 'listrik padam',
    pos: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|mati lampu|blackout|byarpet)/i,
    strong: /(listrik padam|padam listrik|pemadaman listrik|mati listrik|mati lampu|byarpet)/i,
    ctx: /(listrik|pln|pemadaman listrik|padam listrik|mati listrik|mati lampu)/i,
    x: ['("listrik padam" OR "mati listrik" OR "mati lampu" OR "pemadaman listrik" OR "padam listrik" OR byarpet OR blackout) -filter:replies'],
    th: ['mati lampu', 'mati listrik', 'listrik padam', 'PLN padam', 'padam listrik', 'byarpet'],
  },
  {
    id: 'wabah',
    pos: /(wabah|kejadian luar biasa|keracunan (massal|makanan|mbg|pangan|nasi|katering|miras)?|intoksikasi massal|kasus (dbd|campak|difteri|kolera|covid|flu burung))/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|hollywood|dead\s+by\s+daylight|jogar\s+dbd|main\s+dbd|killer|survivor)/i,
    x: ['(wabah OR "keracunan massal" OR "keracunan makanan" OR "keracunan MBG" OR KLB OR "kejadian luar biasa" OR "kasus DBD") -filter:replies'],
    th: ['wabah', 'keracunan massal', 'keracunan MBG', 'demam berdarah', 'kasus DBD', 'kejadian luar biasa'],
  },
  {
    id: 'pemilu',
    local: true,
    pos: /(pemilu|pilkada|pilpres|\bkpu\b|bawaslu|quick count|real count|coblos|surat suara|pilwalkot)/i,
    strong: /(pemilu|pilkada|pilpres|pilwalkot|pilgub|pilbup|quick count|real count|coblos|surat suara|pemungutan suara|kotak suara)/i,
    ctx: /(pemilu|pilkada|pilpres|pemilihan|pemungutan|suara|kursi|partai|caleg|capil|capres|cawapres|paslon|dpr|dprd|kpud|kotak|coblos|golput|tahapan|penghitungan|pasangan|pasangan calon|pilgub|pilbup|pilgici)/i,
    x: ['(pemilu OR pilkada OR pilpres OR KPU OR Bawaslu) -filter:replies'],
    th: ['pemilu', 'pilkada', 'pilpres', '#pilkada'],
  },
  {
    id: 'politik',
    local: true,
    pos: /(partai politik|caleg|capil|daftar caleg|\bdpr\b|\bdprd\b|parlemen|fraksi|koalisi|oposisi|\bkabinet\b(?=[^.\n]{0,35}\b(?:merah\s*putih|indonesia|pemerintah|menteri|presiden|prabowo|jokowi|gibran|reshuffle|rombak|susunan|formasi|sidang|rapat|bayangan|koalisi)\b)|\b(?:merah\s*putih|indonesia|pemerintah|menteri|presiden|prabowo|jokowi|gibran|reshuffle|rombak|susunan|formasi|sidang|rapat|bayangan|koalisi)\b[^.\n]{0,35}\bkabinet\b|(?:reshuffle|rombak|susunan|formasi)[^.\n]{0,20}kabinet|kabinet[^.\n]{0,20}(?:reshuffle|rombak|diumumkan|merah\s*putih)|\bmenteri\b|wakil (presiden|menteri)|\bistana\b|senayan|menko|kadin|\bgubernur\b|\bbupati\b|wali kota|\bpilkada\b|\bpilgub\b|\bpilbup\b|\bpilgici\b|\bkpud\b|impeachment|majelis kehormatan|sidang mk|prabowo|apbn|rapbn|danantara|gibran)/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|hakase|kpop|k-pop|bias[^.\n]{0,10}\bdpr\b|fans?[^.\n]{0,10}\bdpr\b|\bdpr\b[^.\n]{0,120}(?:cream|artic|live|ian|rem|regime|squad|concert|fan|fans|fandom|stan|bias|music|song|songs|track|album|albums|stage|tour|mv|comeback|lyrics|vibrating)|(?:cream|artic|live|ian|rem|regime|album|song|concert|tour|comeback|fandom|kpop|k-pop)[^.\n]{0,120}\bdpr\b|dpr\s+(?:ian|live|cream|artic|rem|regime|squad|gang|crew|member)\b|dream\s+perfect\s+regime)/i,
    x: ['(pemilu OR pilkada OR pilpres OR "partai politik" OR caleg OR "DPR RI" OR "gedung DPR" OR "kabinet merah putih" OR "kabinet Prabowo" OR "reshuffle kabinet" OR menteri) -filter:replies'],
    th: ['pemilu', 'pilkada', 'pilpres', 'DPR RI', 'kabinet merah putih', 'reshuffle kabinet'],
  },
  {
    id: 'konflik',
    local: true,
    pos: /(\bperang\b|\bkonflik\b|\binvasi\b|aneksasi|pendudukan|gencatan senjata|ultimatum|kudeta|pemberontakan|separatis|genosida|blokade|embargo|sandera|pembajakan|pertempuran|darurat militer|darurat sipil|mobilisasi|milisi|paramiliter|peluru kendali|\brudal\b|\bdrone\b|\bdron\b|serangan udara|serangan rudal|\bbom\b|granat|artileri|\btni\b|\btentara\b|militer|perjanjian damai|perundingan damai)/i,
    strong: /(?:gencatan\s+senjata|invasi|kudeta|perang\s+(?:saudara|terbuka|berkecamuk|pecah)|darurat\s+militer|operasi\s+militer|serangan\s+(?:udara|rudal|artileri)|pertempuran\s+(?:sengit|bersenjata)|kkb\s+papua|separatis)/i,
    ctx: /(?:senjata|korban|tewas|pasukan|militer|\btni\b|\bpolri\b|\bkkb\b|\bopm\b|separatis|perbatasan|zona\s+perang|invasi|rudal|peluru|tembak|ledakan|\bbom\b|kudeta|gencatan|pemberontak|artileri|angkatan\s+(?:bersenjata|darat|laut|udara)|pertahanan)/i,
    neg: /(?:upacara\s+(?:peringatan|tabur\s+bunga|hari\s+pahlawan|hut\s+tni)|tabur\s+bunga|hari\s+pahlawan|ziarah\s+nasional|perang\s+(?:antar\s+)?(?:fandom|fans?|warganet|netizen|otaku|kpop|bocil|klub|suporter|game|gamers?|cuitan)|museum\s+militer|drone\s+(?:fpv|rakitan|mainan|kamera|balap|foto|pertanian)|balap\s+drone|serangan\s+(?:jantung|stroke)|perang\s+(?:tarif|dagang|harga|diskon|promo|bintang|opini|narasi|argumen|wacana|tagar|buzzer|medsos|urat\s+syaraf|dingin|kata[- ]kata)|saling\s+serang\s+(?:opini|argumen|narasi|cuitan|komentar)|adu\s+jotos\s+(?:anggota\s+(?:dpr|dprd|dewan|parlemen)|politisi)|perang harga|perang (saudara|dagang|harga|dunia ketiga|polusi|sampah|hati|jiwa|batin|pendapat|online|dunia maya|netizen|gosip)|konflik (batin|psikologis|rumah tangga|hukum|personal)|bom (wacana|waktu|tank|mobil|rakit|dekat|saraf)|\bthe bom\b|\bbom(?:'s)?\s+(?:to|of|for|in|on|at|by|from|with|weather|station|bureau|meteorology|forecast|warning|australia|says?|said|announc\w*|expect\w*|predict\w*|replaces?|wants?|urges?|calls?|issues?|extends?|report\w*|confirm\w*)\b|film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|dirgahayu|kami (akan |sedang )?melaksanakan|wajib hijrah|jauhi yang kafir|khalifahah)/i,
    x: ['(perang OR "gencatan senjata" OR ultimatum OR invasi OR aneksasi OR kudeta OR "perjanjian damai" OR "darurat militer") -filter:replies'],
    th: ['perang', 'konflik', 'gencatan senjata', 'invasi', 'kudeta', 'serangan udara', 'militer', 'tentara', 'TNI', 'rudal', 'drone', 'pertempuran', 'sandera', 'pembajakan', 'ultimatum', 'aneksasi', 'mobilisasi', 'darurat militer', 'perundingan damai'],
  },
  {
    id: 'insiden',
    local: true,
    pos: /(ambruk|runtuh|pohon tumbang|tenggelam|kapal karam|kapal tenggelam|hanyut|tergelincir|jatuh dari gedung|jembatan putus|bangunan roboh)/i,
    strong: /(?:jembatan\s+(?:putus|ambruk|roboh)|gedung\s+(?:ambruk|roboh|runtuh)|bangunan\s+(?:ambruk|roboh|runtuh)|atap\s+(?:ambruk|roboh)|plafon\s+ambruk|kapal\s+(?:tenggelam|karam)|perahu\s+(?:terbalik|tenggelam)|pohon\s+tumbang|orang\s+tenggelam|bocah\s+tenggelam|anak\s+hanyut)/i,
    ctx: /(?:jembatan|gedung|bangunan|atap|plafon|rumah|dinding|konstruksi|tembok|jalan|tebing|tower|tiang|kapal|perahu|sampan|tongkang|speedboat|dermaga|pohon|orang|bocah|anak|korban|warga|penumpang|sungai|laut|danau|ombak|arus)/i,
    neg: /(?:(?:hati(?:ku)?|jiwa(?:ku)?|perasaan(?:ku)?|asmara|cinta|harapan|mentalku|duniaku)[^.\n]{0,20}(?:ambruk|runtuh|roboh|hanyut|tenggelam)|(?:ambruk|runtuh|roboh|hanyut|tenggelam)[^.\n]{0,20}(?:hatiku|jiwaku|perasaanku|cintaku|harapanku|senyuman|tatapan|paras|suara|pelukan)|hanyut\s+(?:oleh|karena|dalam)\s+(?:senyuman|tatapan|cinta|pesona|keindahan|alunan|musik|lagu|belaian)|runtuhnya (NKRI|negara|keluarga|ekonomi|rezim|pemerintah|sistem|karir|hubungan|cinta|pernikahan)|ambruknya (kurs|ekonomi|pendidikan|parlementarisme|rezim|pemerintah|sistem|hubungan|cinta|karir)|(?:ihsg|saham|rupiah|kurs|harga|suara)\s+(?:ambruk|anjlok|runtuh)|tergelincir\s+(?:lidah|dari\s+puncak|klasemen|ke\s+(?:lembah|jurang)\s+(?:dosa|maksiat))|durian\s+runtuh|jembatan\s+cinta|hanyut\s+dalam\s+(?:alunan|suasana|musik|emosi|perasaan|khayalan|lagu)|tenggelam\s+(?:dalam\s+(?:lamunan|duka|kesedihan|kenangan|nostalgia|dosa)|di\s+dasar\s+klasemen))/i,
    x: ['(ambruk OR runtuh OR "pohon tumbang" OR tenggelam OR karam) -filter:replies'],
    th: ['ambruk', 'kapal tenggelam', 'runtuh', 'tenggelam'],
  },
  {
    id: 'kriminal',
    local: true,
    pos: /(pembunuhan|dibunuh|pengeroyokan|dikeroyok|begal|\bcurat\b|perampokan|dirampok|terorisme|narkoba|penculikan|perkosaan|rudapaksa|kdrt|judol|tppo|judi online)/i,
    neg: /(?:dibunuh|pembunuhan)[^.\n]{0,20}(?:rasa|rindu|sepi|waktu|kebosanan|karakter|mimpi|harapan|cinta|batin)|(?:rasa|rindu|sepi|waktu|kebosanan|karakter|mimpi|harapan)[^.\n]{0,20}(?:dibunuh|membunuh)|pembunuhan\s+karakter|membunuh\s+karakter|begal\s+(?:rekening|saldo|pulsa|data|politik|partai|konstitusi)/i,
    x: ['(pembunuhan OR pengeroyokan OR begal OR perampokan OR penculikan OR narkoba) -filter:replies'],
    th: ['pembunuhan', 'begal', 'pengeroyokan', 'perampokan'],
  },
  {
    id: 'kesehatan',
    local: true,
    pos: /(serangan jantung|gagal jantung|henti jantung|stroke|demam berdarah|\bdbd\b|\bdhf\b|covid|korona|influenza|\bflu\b|mpox|cacar monyet|campak|morbili|cacar air|tangan kaki mulut|hfmd|leptospirosis|tifus|thypoid|kolera|rabies|gila anjing|anthrax|difteri|polio|meningitis|meningokokus|ensefalitis|chikungunya|cikungunya|zika|filariasis|kaki gajah|hepatitis|\bhiv\b|\baids\b|kusta|lepra|\bispa\b|pneumonia|bronkopneumonia|bronkitis|hmpv|human metapneumovirus|\brsv\b|\bmers\b|ebola|marburg|lassa|west nile|h5n1|avian influenza|\btbc\b|tuberkulosis|\btb\b|diare|disentri|scabies|kudis|keracunan|intoksikasi|rotavirus|flu burung|h1n1|malaria|wabah|kejadian luar biasa|gagal ginjal|stunting|vaksin|imunisasi|puskesmas|kemenkes|rumah sakit|obat palsu|gizi buruk|miras oplosan|alkohol oplosan|oplosan maut|keracunan mbg|korban mbg|sppg|mual|muntah|makanan basi|bakteri pangan|e\.?\s*coli|salmonella)/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|mayat hidup|hantu|sekuel|layar lebar|sinetron|sinetrik|hollywood|dead by daylight|main\s+dbd|play\s+dbd|dbd[^.\n]{0,30}(match|rank|chapter|killer|survivor|lag|server|mobile|skin|update|repair|macro|rivals|phasmo|twitch|stream|queue|gaming|lobby|game|main|play|take on|grinding|leveling)|deadbydaylight|dead[- ]by[- ]daylight|\b(?:el|la|del|al)\s+dbd\b|\bwe\s+(?:exit|advance|progress|through|win|drew|lost|booked|qualified)\b[^.\n]{0,50}\b(?:cup|final|match|game|tie|round|knockout|semi|qf|sf|league)\b|\b(?:man|player|goal|motm)\s+of\s+the\s+match\b|\bsafe trip home\b|\b(?:full[- ]?time|ft)\s*(?:result|score|whistle|report)\b|\btbc\b[^.\n]{0,40}(lineup|squad|bench|starting|kick.?off|match|game|vs\b|injur|suspend)|\(tbc\)|racun\s+(?:tiktok|shopee|ig|belanja|skincare|ootd|cinta|asmara|dunia)|teracuni|keracunan\s+(?:cinta|asmara)|wabah\s+(?:judi|judol|korupsi|kemiskinan|hoaks|kebohongan|kebencian|intoleransi|k-?pop|drakor|tiktok|cinta|rindu))/i,
    x: ['("demam berdarah" OR DBD OR COVID OR influenza OR campak OR "tangan kaki mulut" OR leptospirosis OR rabies OR kolera OR mpox OR polio OR "gagal ginjal" OR "serangan jantung" OR KLB OR wabah OR imunisasi OR vaksin OR keracunan OR "keracunan massal" OR "keracunan makanan" OR "keracunan MBG" OR "miras oplosan") -filter:replies',
      '("TBC paru" OR tuberkulosis OR (TBC (pasien OR puskesmas OR kemenkes OR paru))) -filter:replies'],
    th: ['demam berdarah', 'serangan jantung', 'stroke', 'wabah', 'TBC', 'influenza', 'keracunan massal', 'keracunan makanan', 'keracunan MBG', 'miras oplosan', 'gagal ginjal', 'vaksin', 'imunisasi', 'DBD', 'covid', 'korona', 'tifus', 'stunting', 'malaria', 'diare', 'campak', 'kolera', 'rabies', 'tuberkulosis', 'pneumonia', 'tangan kaki mulut', 'leptospirosis'],
  },
  {
    id: 'ransomware',
    local: true,
    pos: /(ransomware|malware|lockbit|blackcat|alphv|\bclop\b)/i,
    neg: /(humans?|manusia|people|manusiawi|otak|hati|jiwa|semangat|energi|pikiran)[^.\n]{0,40}(malware|virus)|(malware|virus)[^.\n]{0,40}(humans?|manusia|people|manusiawi|otak|hati|jiwa|semangat|energi|pikiran)/i,
    x: ['(ransomware OR malware) -filter:replies'],
    th: ['ransomware', 'malware', 'bocor data'],
  },
  {
    id: 'serangan siber',
    local: true,
    pos: /(serangan siber|serangan cyber|peretasan|\bperetas\b|diretas|dibobol|kebocoran data|bocor data|pencurian data|(mencuri|curi|curian) data|\bddos\b|data breach|\bbssn\b|\bpdn\b|dieksploitasi|\bcve[- ]?\d{4}|kerentanan|vulnerabilit|backdoor|spyware|skimming|carding|cryptojack|deepfake|deface|defacement|phishing|\bphish|vishing|smishing|sextortion|botnet|\bzero[- ]day\b|\bn[- ]?day\b|infrastruktur kritis|apt\d{1,2}\b|\bc2\b|command and control|leak site|layanan lumpuh|situs lumpuh|gangguan (layanan|sistem|jaringan|aplikasi|infrastruktur)|insiden keamanan|maintenance keamanan|uu pdp|\bpdp\b|dompet kripto|investasi bodong|scam|penipuan online|pinjol ilegal|akun palsu|\bhacker\b|\bcve\b|dieksploitasi|di-?exploit(?:asi|kan)?|exploit\s+(?:celah|kerentanan|sistem|jaringan|server|akun|data|perangkat|zero[- ]day|vulnerabilit))/i,
    neg: /(film|sinema|bioskop|trailer|teaser|poster|nonton|netflix|zombie|sinetron|sinetrik|hackathon|mbti|enneagram)/i,
    x: ['("serangan siber" OR peretasan OR diretas OR "kebocoran data" OR BSSN OR DDoS OR exploit OR phishing OR ransomware OR deepfake) -filter:replies'],
    th: ['serangan siber', 'kebocoran data', 'ransomware', 'phishing', 'exploit', 'diretas', 'BSSN', 'peretasan', 'dibobol', 'ddos', 'deepfake', 'penipuan online', 'pinjol', 'investasi bodong', 'situs lumpuh', 'insiden keamanan', 'akun palsu'],
  },
  {
    id: 'akun dibajak',
    local: true,
    pos: /(akun[^.\n]{0,30}(dibajak|diretas|dibobol|di-?hack|kena hack|disusupi)|akun (instagram|facebook|whatsapp|telegram|twitter|\bx\b|tiktok)[^.\n]{0,25}(dibajak|diretas|dibobol|hack))/i,
    x: ['(akun (dibajak OR diretas OR dibobol OR "kena hack")) -filter:replies'],
    th: ['akun dibajak', 'akun diretas', 'akun dibobol'],
  },
  {
    id: 'mbg',
    local: true,
    pos: /\bmbg\b|makan bergizi gratis|makan gratis|program makan gratis|gizi gratis|makan siang gratis|\bsppg\b|badan gizi nasional|\bbgn\b|keracunan mbg/i,
    strong: /(makan bergizi gratis|makan gratis|program makan gratis|gizi gratis|makan siang gratis|\bsppg\b|badan gizi nasional|keracunan mbg)/i,
    ctx: /(makan|bergizi|gizi|badan gizi|program|keracunan|gratis|balita|sekolah|kantin|siswa|mbg|sppg|dapur)/i,
    neg: /(resep|food ?vlog|foodreview|food review|cooking|memasak|review makanan|mbappe|real madrid|bundesliga|my bini|\b(?:masih|udah|sudah|belum|blm|baru|jam\s+segini|ga|gak|nggak|lagi|susah)\s+bgn\b|\bbgn\s+(?:tidur|pagi|siang|sore|malem|malam|jam)\b|\bmbg\s+disband\b|\bdisband\b)/i,
    x: ['("makan bergizi gratis" OR MBG OR SPPG OR "badan gizi nasional" OR BGN) -filter:replies'],
    th: ['makan bergizi gratis', 'MBG', '#makanbergizigratis'],
  },
  {
    id: 'bbm',
    local: true,
    pos: /\bbbmm?\b|bahan bakar (minyak|non ?subsidi|subsidi)|pertalite|pertamax|dexlite|biosolar|\bspbu\b|kelangkaan (bbm|minyak|solar)|antrean (spbu|bbm|minyak)|harga (bbm|minyak tanah)|harga minyak|subsidi energi|gas langka/i,
    neg: /(minyak (goreng|zaitun|wangi)|solar (panel|pembangkit)|bensin (romantis|story)|\bbbmm?\b[^.\n]{0,40}(bola|football|soccer|liga|premier league|manager|coach|lineup|formasi|gol\b|assist))/i,
    x: ['(BBM OR Pertalite OR Pertamax OR "harga BBM" OR SPBU OR "bahan bakar" OR "minyak tanah") -filter:replies'],
    th: ['BBM', 'harga BBM', 'Pertalite', 'SPBU', '#bbm'],
  },
  {
    id: 'pangan',
    local: true,
    pos: /(minyak goreng|harga (beras|telur|daging|cabai|gula|tepung|beras medium)|sembako|inflasi pangan|pangan (mahal|pasti)|stok (beras|pangan|sembako)|impor (beras|pangan|gula|tepung)|operasi pasar|bantuan pangan|beras oplosan|harga pangan|bawang merah|daging ayam)/i,
    neg: /(resep|menu masak|food ?vlog|kuliner|review (makanan|resto))/i,
    x: ['("minyak goreng" OR "harga beras" OR sembako OR "operasi pasar" OR "inflasi pangan" OR "harga telur" OR "harga daging") -filter:replies'],
    th: ['minyak goreng', 'harga beras', 'sembako', 'inflasi pangan', 'harga telur', 'harga daging', 'harga cabai', 'stok beras', 'impor beras', 'operasi pasar'],
  },
  {
    id: 'bansos',
    local: true,
    pos: /(bansos|bantuan sosial|bantuan langsung tunai|\bblt\b|\bpkh\b|\bbpnt\b|\bbsu\b|subsidi (listrik|gula|upah|pupuk)|rastra|kartu (sembako|prakerja|indonesia pintar)|program keluarga harapan|kemensos|\bdtks\b)/i,
    strong: /(bansos|bantuan sosial|bantuan langsung tunai|subsidi (listrik|gula|upah|pupuk)|rastra|kartu (sembako|prakerja|indonesia pintar)|program keluarga harapan|kemensos|\bdtks\b)/i,
    ctx: /(bansos|bantuan|pemerintah|kuota|cair|desember|regulasi|program|tunai|sosial|dtks|kemensos|penerima|kartu|subsidi|raskin|sembako|warga|rakyat|desa|dana|rp|tahap|nik|ktp|dapat|dapet|\bpkh\b|\bbpnt\b|\bbsu\b)/i,
    neg: /(film|sinema|sinetron|nonton|sandwich|grilled\s+cheese|bacon|lettuce|tomato|bread|toast|burger|deli|mayo|resep|food|\bblt\b[^.\n]{0,50}(?:sandwich|grilled\s+cheese|bacon|lettuce|tomato|toast|burger|deli|lunch)|(?:sandwich|grilled\s+cheese|bacon|lettuce|tomato|toast|burger|deli)\b[^.\n]{0,50}\bblt\b)/i,
    x: ['(bansos OR "bantuan sosial" OR "bantuan langsung tunai" OR PKH OR BPNT OR BSU OR (BLT (bansos OR bantuan OR cair OR warga OR kemensos OR desa)) OR "subsidi listrik" OR "kartu prakerja") -filter:replies'],
    th: ['bansos', 'bantuan sosial', 'PKH', 'BSU', 'subsidi listrik', 'BLT', 'BPNT', 'rastra', 'kartu sembako', 'kartu prakerja'],
  },
  {
    id: 'hukum',
    local: true,
    pos: /(rkuhap|rkuhp|\bkuhp\b|\bkuhap\b|tipikor|korupsi|gratifikasi|suap|penyuapan|pengadilan|putusan (pengadilan|hakim)|kasasi|\bdiversi\b|kejaksaan|upacara hukuman mati|eksekusi (hukuman|mati)|rehabilitasi narkotika)/i,
    neg: /(film|sinema|sinetron|sinetrik|trailer|nonton|netflix)/i,
    x: ['(RKUHAP OR RKUHP OR KUHP OR KUHAP OR tipikor OR korupsi OR KPK OR kejaksaan OR "putusan pengadilan") -filter:replies'],
    th: ['RKUHAP', 'tipikor', 'korupsi', 'KPK', 'RKUHP', 'KUHP', 'KUHAP', 'pengadilan', 'kasasi', 'suap', 'kejaksaan'],
  },
  {
    id: 'transport',
    local: true,
    pos: /(kereta api|\bkai\b|delay (penerbangan|pesawat|kereta)|penerbangan (delay|dibatalkan|batal landas)|tiket (pesawat|kereta|kapal)|\bdermaga\b|kapal feri|\bferry\b|mudik|batal mudik|tol (macet|boleh|putus|buntu|lalu lintas)|jalan tol|busway|transjakarta|\bmrt\b|\blrt\b|\bkrl\b|angkot|ojol|gojek|grabfood|\bgrab\s*(?:car|bike|food|motor|ride|dana|share|express)\b|taxi online|kecelakaan (kereta|bus|truk)|bandara)/i,
    strong: /(kereta api|tiket (pesawat|kereta|kapal)|delay (penerbangan|pesawat|kereta)|penerbangan (delay|dibatalkan|batal landas)|kapal (feri|tenggelam|karam)|\bdermaga\b|\bferry\b|busway|transjakarta|jalan tol|tol (macet|boleh|putus|buntu|lalu lintas)|mudik|batal mudik|taxi online|kecelakaan (kereta|bus|truk))/i,
    ctx: /(jakarta|jabodetabek|indonesia|stasiun|bandara|terminal|pelabuhan|dermaga|mudik|pulang kampung|penumpang|tiket|tol|busway|transjakarta|kereta api|commuter line|delay|batal landas|angkutan umum|ojek online|angkot umum|penerbangan|pesawat|kapal|ferry|macet|gangguan|kerusakan|dibatalkan|kecelakaan|tabrakan|kembali normal|operasional|naik|turun|perjalanan)/i,
    neg: /(judi|togel|slot online|gacor|prediksi)/i,
    x: ['(kereta api OR "delay penerbangan" OR "penerbangan dibatalkan" OR "jalan tol" OR mudik OR ojol OR TransJakarta OR MRT OR KRL OR angkot OR LRT OR "kapal feri" OR "batal mudik" OR dermaga OR "tol macet") -filter:replies'],
    th: ['kereta api', 'delay penerbangan', 'jalan tol', 'mudik', 'ojol', 'TransJakarta', 'MRT', 'KRL', 'LRT', 'angkot', 'penerbangan dibatalkan', 'tol macet', 'kapal feri', 'batal mudik', 'dermaga'],
  },
  {
    id: 'pendidikan',
    local: true,
    pos: /(\bukt\b|biaya kuliah tunggal|beasiswa (dipotong|batal|ditolak|gelombang)|(?:gaji|nasib|tuntutan|kesejahteraan|seleksi|pengangkatan|demo|mogok|protes|dianiaya|kasus)\s+guru\s+(?:honorer|pppk)|guru\s+(?:honorer|pppk)\s+(?:demo|mogok|protes|dituntut|dipecat|menuntut|tuntut|tertahan|gaji|nunggak|belum cair|nasib|polemik|teraniaya|dianiaya|korban)|keracunan (kantin|sekolah|siswa|mahasiswa|mbg|massal)|murid (pingsan|tenggelam|meninggal|kecelakaan)|siswa (pingsan|tenggelam|meninggal|keracunan|kecelakaan)|mahasiswa (pingsan|tenggelam|meninggal|keracunan|\bdemo\b|unjuk rasa|demonstrasi)|sekolah (kebakaran|longsor|ambruk|ditutup|runtuh|tenggelam)|kampus (kebakaran|longsor|ambruk)|\bsnbt\b|\bsbmptn\b|kurikulum merdeka|\bpppk\b|\bcpns\b|\bcasn\b|\bspp\b|\blpdp\b|kip kuliah|sekolah gratis)/i,
    neg: /(film|sinema|bioskop|sinetron|nonton|netflix|\b(?:kode|css|html|frontend|komponen|component|ot[4-9]|ot1\d)\b|\bmember\b[^.\n]{0,40}\bkangen\b|(?:kyk|kaya|kayak|seperti)\s+(?:nunggu|menunggu)[^.\n]{0,30}(?:snbt|sbmptn))/i,
    x: ['(UKT OR "biaya kuliah" OR "siswa pingsan" OR "keracunan sekolah" OR "sekolah kebakaran" OR beasiswa OR SNBT OR "gaji guru honorer" OR "nasib guru honorer" OR "guru honorer demo") -filter:replies'],
    th: ['UKT', 'biaya kuliah', 'gaji guru honorer', 'nasib guru honorer', 'guru honorer demo', 'siswa pingsan', 'keracunan sekolah', 'beasiswa', 'SNBT', 'SBMPTN', 'kurikulum merdeka', 'pengangkatan guru PPPK', 'sekolah ambruk', 'sekolah longsor', 'beasiswa dipotong'],
  },
];
for (const t of SOC_TOPICS) t.adhoc = false;

const SOC_SEA_RE = /(kapal|laut|selat|ombak|nelayan|feri|perahu|sungai|perairan|samudra|ocean|boat|ship|tpi|dermaga)/i;
function socFixEvents(res) {
  for (const f of res.findings || []) {
    const ev = f.evidence || '';
    if (f.topic === 'insiden' && f.type === 'maritime_accident' && !SOC_SEA_RE.test(ev)) f.type = 'kecelakaan';
    else if (f.topic === 'kecelakaan' && /tenggelam|karam|hanyut/i.test(ev) && SOC_SEA_RE.test(ev)) f.type = 'maritime_accident';
    else if (f.topic === 'wabah') { f.type = 'health_incident'; if (!f.category) f.category = 'kesehatan'; }
  }
  for (const f of res.events || []) {
    const ev = f.evidence || '';
    if (f.topic === 'insiden' && f.type === 'maritime_accident' && !SOC_SEA_RE.test(ev)) f.type = 'kecelakaan';
    else if (f.topic === 'kecelakaan' && /tenggelam|karam|hanyut/i.test(ev) && SOC_SEA_RE.test(ev)) f.type = 'maritime_accident';
    else if (f.topic === 'wabah') { f.type = 'health_incident'; if (!f.category) f.category = 'kesehatan'; }
  }
  return res;
}

const SOC_MOTOR_MARK_RE = /grand\s*prix|grandprix|formula\s*1|\bf1\b|kualifikasi|qualifying|sprint\s+race|pole\s+position|podium|parc\s*ferme|safety\s*car|safetycar|red\s+flag|bendera\s+(?:merah|kuning)|pit\s+(?:stop|lane)|push-?lap|out-?lap|drs\s*zone|ers\s*zone|oversteer|understeer|lock-?up|downforce|aerodinamis|steering\s+wheel|cockpit|\bsirkuit\b|scuderia|red\s+bull(?:\s+racing)?|mercedes-amg|aston\s+martin|alpine\s+f1|haas\s+f1|racing\s+bulls|sauber|cadillac\s+f1|\bmclaren\b|balap\s+(?:motor|mobil|formula|f1|grup)/gi;
function socIsMotorsport(t) {
  const m = String(t || '').matchAll(SOC_MOTOR_MARK_RE);
  return new Set([...m].map(x => x[0].toLowerCase())).size >= 2;
}

function socAssess(text, extra, context) {
  const t = String(text || '');
  const listing = SOC_LISTING_RE.test(t) && SOC_LISTING_DEAL.test(t);
  const topics = socIsMotorsport(t) ? SOC_TOPICS.filter(tp => tp.id !== 'kecelakaan') : SOC_TOPICS;
  const res = socFixEvents(ASSESS.assess(t, topics.concat(extra || []), {
    noise: SOC_NOISE_RE,
    spam: SOC_SPAM_RE,
    listing,
    onCache: (hit, size) => diagnostics.recordCache(hit, size),
  }));
  res.provenance = CLUSTER.classifySourceProvenance(context || {}, res);
  if (context && context.recordDiagnostics) {
    diagnostics.recordClassification(res, context);
  }
  return res;
}

function socTopics(text, extra) { return socAssess(text, extra).topics; }

function explainPost(text, extra, context) {
  const res = socAssess(text, extra, context);
  return {
    classifierVersion: res.version,
    version: res.version,
    textLength: String(text || '').length,
    normalizedText: res.normalizedText,
    contentHash: res.contentHash,
    intent: res.intent,
    feedLane: res.feedLane,
    signalEligible: res.signalEligible,
    feedEligible: res.feedEligible,
    confidence: res.confidence,
    classification: res.classification,
    geographicContext: res.geographicContext,
    event: res.event,
    extractedEvents: res.extractedEvents,
    provenance: res.provenance,
    topics: res.topics,
    reasons: res.reasons,
    rejectedReasons: res.rejectedReasons,
    clauses: res.layerTrace ? res.layerTrace.normalization.clauses : 0,
    layerTrace: res.layerTrace,
  };
}

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SOC_ADHOC_GENERIC = new Set(('rumah warga orang anak pria wanita ibu bapak mobil motor jalan tanah lahan gedung kantor desa kota hari bulan tahun waktu tempat kerja loker jasa harga biaya uang pasar toko produk barang sekolah kampus kuliah teman keluarga makan minum').split(' '));
function socAdhoc(phrases) {
  return (phrases || [])
    .map(ph => String(ph || '').replace(/["'\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(ph => {
      if (ph.length < 3) return false;
      const low = ph.toLowerCase();
      if (SOC_ADHOC_GENERIC.has(low) && !ph.includes(' ')) return false;

      if (ASSESS.isGenericLocationPhrase(low)) return false;
      return true;
    })
    .slice(0, 2)
    .map(ph => ({
      id: ph.toLowerCase(),
      adhoc: true,
      local: false,
      pos: new RegExp('\\b' + escRe(ph).replace(/\s+/g, '\\s+') + '\\b', 'i'),
      x: ['"' + ph + '" -dijual -kpr -rumah -sewa -loker -filter:replies'],
      th: [ph],
    }));
}

function socKeepX(p) {
  const text = p.text || '';
  const likes = p.likes || p.like_count || 0;
  const topics = p.topics || (p.assessment && p.assessment.topics) || [];
  const signal = p.assessment && p.assessment.signalEligible;
  if (p.assessment && p.assessment.version === ASSESS.VERSION && !p.assessment.feedEligible) return false;
  if (!signal && p.name && (SOC_SCRIPT_RES.hangul.test(p.name) || SOC_SCRIPT_RES.kana.test(p.name)) &&
      topics.length > 0 && topics.every(t => /^(?:pendidikan|hukum|bansos)$/.test(t))) return false;
  if (/^\s*@\w+/.test(text) && likes < 10 && topics.length === 0 && !signal) return false;
  const mentions = text.match(/@\w+/g) || [];
  if (mentions.length >= 3 && likes < 20 && topics.length === 0 && !signal) return false;
  if (!signal && SOC_LISTING_RE.test(text) && SOC_LISTING_DEAL.test(text)) return false;
  return true;
}

function socKeepTh(p) {
  if (p.assessment && p.assessment.version === ASSESS.VERSION && !p.assessment.feedEligible) return false;
  if (p.is_reply && (p.like_count || 0) < 5 && !(p.topics || []).length) return false;
  if (!p.assessment?.signalEligible && SOC_LISTING_RE.test(p.text || '') && SOC_LISTING_DEAL.test(p.text || '')) return false;
  return true;
}

function socBalance(arr, max, userOf, perTopic = 0.22, perUser = 3, userCap = 10) {
  if (!(max > 0) || !Array.isArray(arr) || !arr.length) return [];
  const capT = Math.max(8, Math.ceil(Math.min(max, arr.length) * perTopic)), tc = Object.create(null), uc = Object.create(null), ug = Object.create(null), out = [];
  const isSig = p => !!(p && p.assessment && p.assessment.signalEligible === true);
  const isRep = p => isSig(p) || !!(p && p.assessment && p.assessment.reportType === 'reported');
  for (const want of [isSig, p => !isSig(p) && isRep(p), p => !isSig(p) && !isRep(p)]) {
    for (const p of arr) {
      if (!want(p)) continue;
      const tps = [...new Set(p.topics || [])], u = String(userOf(p) || '?').toLowerCase();
      if (!tps.length || tps.some(t => (tc[t] || 0) >= capT || (uc[u + '|' + t] || 0) >= perUser)) continue;
      if (!isSig(p) && userCap > 0 && (ug[u] || 0) >= userCap) continue;
      for (const t of tps) { tc[t] = (tc[t] || 0) + 1; uc[u + '|' + t] = (uc[u + '|' + t] || 0) + 1; }
      if (!isSig(p)) ug[u] = (ug[u] || 0) + 1;
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function socQueries(kind, extra) {
  const out = [];
  for (const tp of extra && extra.length ? SOC_TOPICS.concat(extra) : SOC_TOPICS) {
    for (const q of tp[kind] || []) out.push({ t: tp.id, q });
  }
  return out;
}

function socHot(posts, now = Date.now()) {
  const W = 90 * 60e3, B = 24 * 3600e3, windows = Math.ceil(B / W);
  const st = Object.create(null);
  for (const p of posts) {
    const age = now - p.ts;
    if (!Number.isFinite(p.ts) || p.ts <= 0 || age < 0 || age > B || !['x', 'th'].includes(p.platform)) continue;
    const author = String(p.user || '').toLowerCase().replace(/^@/, '');
    for (const t of new Set(p.topics || [])) {
      const e = st[t] || (st[t] = { x: 0, th: 0, rx: new Set(), rt: new Set(), buckets: new Map() });
      e[p.platform]++;
      if (!author) continue;
      if (age < W) (p.platform === 'x' ? e.rx : e.rt).add(author);
      else {
        const bucket = Math.floor(age / W), users = e.buckets.get(bucket) || new Set();
        users.add(p.platform + ':' + author); e.buckets.set(bucket, users);
      }
    }
  }
  const stats = {}, hot = [];
  for (const [t, e] of Object.entries(st)) {
    stats[t] = { x: e.x, th: e.th };
    const users = e.rx.size + e.rt.size;
    const baseRate = [...e.buckets.values()].reduce((n, s) => n + s.size, 0) / (windows - 1);
    const both = e.rx.size > 0 && e.rt.size > 0;
    if (users < 3) continue;
    const score = users / (1 + baseRate);
    hot.push({ id: t, users, both, score: +score.toFixed(2), coverage: 'sampled', unit: 'platform_accounts' });
  }
  hot.sort((a, b) => b.score - a.score);
  return { stats, hot: hot.slice(0, 6) };
}

const SOC_TSTOP = new Set(('yang dan di ke dari untuk pada dengan adalah ini itu ada tidak akan juga telah sudah bisa lebih sangat para dia kami kita mereka sebuah seorang suatu saat ketika setelah sebelum hingga oleh karena maka jika hari minggu senin selasa rabu kamis jumat sabtu januari februari maret april mei juni juli agustus september oktober november desember breaking news terbaru update foto video live hasil wib wit daring online pemerintah menteri presiden indonesia daerah warga polisi damkar bpbd dishub pasar korban evakuasi massa jumlah ribu juta ratusan ribuan jutaan miliar triliun total resmi viral heboh terduga diduga kini paling orang persen masyarakat pihak oknum pelaku tersangka ibu bapak kali pemkot polda polres kejaksaan kemensos kemenkeu kemendagri detik cnn tempo liputan6 republika tribun cnbc antara jawapos okezone kumparan suara merdeka sindonews jpnn tvri inews media news kompas viva metrotvnews rmol infopublik jabarprov korankaltim tvone merahputih poskota beritasatu gridoto wowkeren bola bolaoverza mediaindonesia faktualnews berita foto video gallery wawancara investigasi khusus daerah nasional internasional ekonomi hiburan selebriti olahraga dishub cumplik the and for with that this from have has are was were will would can could should not but all any more than then when what which who how its our your their his her').split(' '));
const socAuthor = p => String((p && (p.user || p.handle || p.username)) || '').toLowerCase().replace(/^@/, '');
const socInWin = (p, now, windowMs) => {
  const ts = p && p.ts, age = now - ts;
  return Number.isFinite(ts) && ts > 0 && age > 0 && age <= windowMs;
};
const socClean = t => String(t || '').replace(/https?:\/\/\S+/g, ' ').replace(/@[\w]+/g, ' ');
const SOC_PHRASE_RE = /[A-Z][A-Za-z'&]{2,}(?:\s+(?:[A-Z][A-Za-z'&]{2,}|[A-Z]{2,8})){0,3}/g;
const SOC_TAG_RE = /#([\p{L}\p{N}_]+)/gu;

function socPhraseScan(posts, { now = Date.now(), windowMs = 3 * 3600e3, minUsers = 3, exclude = null, max = 8 } = {}) {
  const excl = exclude ? new Set(exclude instanceof Set ? [...exclude] : exclude) : null;
  const ok = (id, multi) => {
    if (id.length < 4 || id.length > 42) return false;
    if (!/[\p{L}]/u.test(id)) return false;
    const words = id.split(' ');
    if (multi && words.length < 2) return false;
    if (words.some(w => w.length < 3 || SOC_TSTOP.has(w))) return false;
    if (SOC_FOREIGN_RE.test(id)) return false;
    if (ASSESS.isGenericLocationPhrase(id)) return false;
    if (excl) for (const t of excl) {
      const tl = String(t).toLowerCase();
      if (id === tl || id.includes(tl) || tl.includes(id)) return false;
    }
    return true;
  };
  const scores = new Map();
  for (const p of posts || []) {
    if (!socInWin(p, now, windowMs)) continue;
    const text = socClean(p.text);
    if (!text.trim()) continue;
    const author = socAuthor(p);
    const found = new Map();
    for (const m of text.matchAll(SOC_PHRASE_RE)) {
      const words = m[0].trim().split(/\s+/);
      for (let len = words.length; len >= 2; len--) {
        for (let s = 0; s + len <= words.length; s++) {
          const ph = words.slice(s, s + len).join(' ');
          const id = ph.toLowerCase();
          if (ok(id, true) && !found.has(id)) found.set(id, ph);
        }
      }
    }
    for (const m of text.matchAll(SOC_TAG_RE)) {
      const id = m[1].toLowerCase().replace(/_+/g, ' ').trim();
      if (ok(id, false) && !found.has(id)) found.set(id, id);
    }
    for (const [id, ph] of found) {
      const e = scores.get(id) || (scores.set(id, { ph, users: new Set(), n: 0 }), scores.get(id));
      if (author) e.users.add(author);
      e.n++;
    }
  }
  return [...scores.entries()]
    .filter(([, e]) => e.users.size >= minUsers)
    .sort((a, b) => (b[1].users.size - a[1].users.size) || (b[1].n - a[1].n))
    .slice(0, max)
    .map(([id, e]) => ({ ph: e.ph, id, users: e.users.size, n: e.n }));
}

const SOC_KW_RE = /[a-z][a-z'-]{3,}/g;
function socKeywordMine(posts, topicId, { now = Date.now(), windowMs = 6 * 3600e3, maxTerms = 8 } = {}) {
  const id = String(topicId || '').toLowerCase();
  const topic = SOC_TOPICS.find(t => t.id === id);
  if (!topic) return [];
  const hay = (topic.th || []).concat(topic.x || []).join(' ').toLowerCase();
  const df = new Map();
  let scanned = 0;
  for (const p of posts || []) {
    if (scanned >= 400) break;
    if (!socInWin(p, now, windowMs)) continue;
    const tps = (p.topics || []).map(t => String(t).toLowerCase());
    if (!tps.includes(id) && String(p.q || '').toLowerCase() !== id) continue;
    scanned++;
    const text = socClean(p.text);
    if (socHashJunk(text) || socNonLatin(text) || socVi(text)) continue;
    const seen = new Set();
    for (const m of text.toLowerCase().matchAll(SOC_KW_RE)) {
      const term = m[0].replace(/^['-]+|['-]+$/g, '');
      if (term.length < 4 || seen.has(term)) continue;
      if (SOC_TSTOP.has(term) || SOC_FOREIGN_RE.test(term)) continue;
      if (hay.includes(term)) continue;
      seen.add(term);
      df.set(term, (df.get(term) || 0) + 1);
    }
  }
  const need = Math.max(3, Math.ceil(scanned * 0.01));
  return [...df.entries()]
    .filter(([, n]) => n >= need)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, dfN]) => ({ term, df: dfN }));
}

const SOC_CLASSIFIER_VERSION = ASSESS.VERSION;
module.exports = {
  CLASSIFIER_VERSION: SOC_CLASSIFIER_VERSION,
  SOC_TOPICS,
  socAssess,
  socTopics,
  socAdhoc,
  socKeepX,
  socKeepTh,
  socBalance,
  socQueries,
  socHot,
  socNonLatin,
  socVi,
  socHashJunk,
  astroturfSig,
  socForeignLang,
  socPhraseScan,
  socKeywordMine,
  explainPost,
  diagnostics,
  clusterIncidents: CLUSTER.clusterIncidents,
  classifySourceProvenance: CLUSTER.classifySourceProvenance,
  isNearDuplicate: CLUSTER.isNearDuplicate,
  deduplicatePosts: CLUSTER.deduplicatePosts,
  isGenericLocationPhrase: ASSESS.isGenericLocationPhrase,
  normalizeIndonesian: ASSESS.normalizeIndonesian,
  INTENTS: ASSESS.INTENTS,
  FEED_LANES: ASSESS.FEED_LANES,
  SOC_FOREIGN_RE,
  SOC_LOCAL_RE,
  SOC_LISTING_RE,
  SOC_LISTING_DEAL,
  SOC_SPAM_RE,
  SOC_NOISE_RE,
};
