
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');


const MONGO_URI = 'UPDATE HERE';
const MONGO_DB  =  'UPDATE HERE';
const COLLECTION = 'UPDATE HERE';

async function main() {
    const file = process.argv[2];
    if (!file) {
        console.error('Usage: node migrateStaticOffers.js <jsonFile>');
        process.exit(1);
    }

    const fullPath = path.resolve(file);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const data = JSON.parse(raw);

    if (!data.operator || !data.subscriptionType || !data.offers) {
        throw new Error('JSON must contain operator, subscriptionType, and offers');
    }


    const offers = {};
    for (const [amount, list] of Object.entries(data.offers)) {
        if (!/^\d+$/.test(amount)) throw new Error(`Non-integer amount key: ${amount}`);
        if (!Array.isArray(list)) throw new Error(`offers["${amount}"] is not an array`);
        offers[amount] = list.map((o, i) => {
            if (typeof o.id !== 'number' || !Number.isInteger(o.id))
                throw new Error(`offers["${amount}"][${i}].id must be an integer`);
            if (typeof o.label !== 'string')
                throw new Error(`offers["${amount}"][${i}].label must be a string`);
            return { wafrId: o.id, label: o.label };
        });
    }

    const now = new Date();
    const filter = { operator: data.operator, subscriptionType: data.subscriptionType };

    const client = new MongoClient(MONGO_URI);
    const t0 = Date.now();
    try {
        await client.connect();
        const col = client.db(MONGO_DB).collection(COLLECTION);

        const existing = await col.findOne(filter, { projection: { offers: 1 } });
        const offersUnchanged = existing && deepEqualOffers(existing.offers, offers);

        let action, res = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
        if (offersUnchanged) {
            action = 'unchanged';
            res.matchedCount = 1;
        } else if (existing) {
            res = await col.updateOne(filter, {
                $set: { operator: data.operator, subscriptionType: data.subscriptionType, offers, updatedAt: now },
            });
            action = 'updated';
        } else {
            res = await col.updateOne(filter, {
                $set: { operator: data.operator, subscriptionType: data.subscriptionType, offers, updatedAt: now },
                $setOnInsert: { createdAt: now },
            }, { upsert: true });
            action = 'inserted';
        }
        const ms = Date.now() - t0;

        // metrics
        const amounts = Object.keys(offers).map(Number).sort((a, b) => a - b);
        const totalOffers = amounts.reduce((n, a) => n + offers[String(a)].length, 0);
        // mongodb@4+ returns ObjectId directly; mongodb@3 wraps it as { _id }
        const insertedId = res.upsertedId && (res.upsertedId._id || res.upsertedId);

        console.log(`${action} ${data.operator}/${data.subscriptionType}  (${ms} ms)`);
        if (insertedId) console.log(`  _id            : ${insertedId}`);
        else if (existing) console.log(`  _id            : ${existing._id}`);
        console.log(`  file           : ${fullPath}`);
        console.log(`  total offers   : ${totalOffers}`);
        console.log(`  amount range   : ${amounts[0]} → ${amounts[amounts.length - 1]}`);
        console.log(`  per-bucket     :`);
        for (const a of amounts) {
            const ids = offers[String(a)].map(o => o.wafrId);
            console.log(`     ${String(a).padStart(5)} → [${ids.join(', ')}]`);
        }
        console.log(`  matched=${res.matchedCount}  modified=${res.modifiedCount}  upserted=${res.upsertedCount}`);
    } finally {
        await client.close();
    }
}


function deepEqualOffers(a, b) {
    if (!a || !b) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        const la = a[k], lb = b[k];
        if (!Array.isArray(la) || !Array.isArray(lb) || la.length !== lb.length) return false;
        for (let i = 0; i < la.length; i++) {
            if (la[i].wafrId !== lb[i].wafrId || la[i].label !== lb[i].label) return false;
        }
    }
    return true;
}

main().catch(err => { console.error(err.message); process.exit(1); });
