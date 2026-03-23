const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ACTRESSES_FILE = path.join(__dirname, '..', 'data', 'actresses_all.json');
const PROFILES_FILE = path.join(__dirname, '..', 'data', 'actress_profiles.json');

const apiId = process.env.DMM_API_ID;
const affiliateId = process.env.DMM_AFFILIATE_ID;

if (!apiId || !affiliateId) {
    console.error('API credentials missing in .env');
    process.exit(1);
}

// 既存のプロフィールデータを読み込む
let profiles = {};
if (fs.existsSync(PROFILES_FILE)) {
    try {
        profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
    } catch (e) {
        console.error('Error reading profiles file', e);
    }
}

// 対象女優リストを読み込む
let actresses = [];
if (fs.existsSync(ACTRESSES_FILE)) {
    actresses = JSON.parse(fs.readFileSync(ACTRESSES_FILE, 'utf-8'));
} else {
    console.error('Actresses list not found.');
    process.exit(1);
}

// 1秒待機用関数
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// メイン処理
async function run() {
    let newFetches = 0;
    let notFounds = 0;

    // 既に取得済みのものはスキップ
    const targetActresses = actresses.filter(a => !profiles[a.name] && !profiles[`NOT_FOUND_${a.name}`]);
    
    console.log(`Total actresses: ${actresses.length}`);
    console.log(`Remaining to fetch: ${targetActresses.length}`);

    if (targetActresses.length === 0) {
        console.log('All actress profiles are already fetched.');
        return;
    }

    for (let i = 0; i < targetActresses.length; i++) {
        const act = targetActresses[i];
        const name = act.name;
        
        const url = `https://api.dmm.com/affiliate/v3/ActressSearch?api_id=${apiId}&affiliate_id=${affiliateId}&keyword=${encodeURIComponent(name)}&output=json`;
        
        try {
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.result && data.result.status == 200 && data.result.actress && data.result.actress.length > 0) {
                const hit = data.result.actress.find(a => a.name === name) || data.result.actress[0];
                
                profiles[name] = {
                    id: hit.id,
                    name: hit.name,
                    ruby: hit.ruby || '',
                    bust: hit.bust || null,
                    waist: hit.waist || null,
                    hip: hit.hip || null,
                    height: hit.height || null,
                    cup: hit.cup || null,
                    birthday: hit.birthday || null,
                    blood_type: hit.blood_type || null,
                    updated_at: new Date().toISOString()
                };
                console.log(`[${i+1}/${targetActresses.length}] OK: ${name} (Cup: ${hit.cup||'?'})`);
                newFetches++;
            } else {
                profiles[`NOT_FOUND_${name}`] = true;
                notFounds++;
                console.log(`[${i+1}/${targetActresses.length}] NO: ${name} | API Status: ${data?.result?.status || 'Unknown'} | MSG: ${data?.result?.message || 'None'}`);
                if (data?.result?.status != 200) {
                    console.log('Full Error Data:', JSON.stringify(data));
                }
            }
        } catch (e) {
            console.error(`[${i+1}/${targetActresses.length}] ERR for ${name}:`, e.message);
        }

        // 10件ごとにセーブ
        if ((i + 1) % 10 === 0 || i === targetActresses.length - 1) {
            fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
        }

        // 1秒に1回リクエスト制限
        await sleep(1000);
    }
    
    console.log(`Finished. New: ${newFetches}, NotFound: ${notFounds}`);
}

run().catch(console.error);
