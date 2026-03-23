const fs = require('fs');

async function testFetchProfile(actressName) {
    console.log(`Testing profile scrape for: ${actressName}`);
    try {
        require('dotenv').config({ path: '../.env' });
        const apiId = process.env.FANZA_API_ID;
        const affiliateId = process.env.FANZA_AFFILIATE_ID;
        
        if (!apiId || !affiliateId) {
            console.log('FANZA keys not found in ../site/.env');
            return;
        }

        const url = `https://api.dmm.com/affiliate/v3/ActressSearch?api_id=${apiId}&affiliate_id=${affiliateId}&keyword=${encodeURIComponent(actressName)}&output=json`;
        const res = await fetch(url);
        const data = await res.json();
        
        if(data.result && data.result.status === 200 && data.result.actress && data.result.actress.length > 0) {
           const act = data.result.actress[0];
           console.log(`Found: ${act.name} (ID: ${act.id}, Ruby: ${act.ruby})`);
           console.log(`Bust: ${act.bust}, Waist: ${act.waist}, Hip: ${act.hip}, Height: ${act.height}, Cup: ${act.cup}`);
           console.log(`Birthday: ${act.birthday}, Blood: ${act.blood_type}`);
           console.log('---');
        } else {
           console.log(`Not found: ${actressName}`);
           console.log('---');
        }
    } catch(e) {
        console.error(e);
    }
}

async function main() {
    await testFetchProfile('深田えいみ');
    await testFetchProfile('涼森れむ');
}

main();
