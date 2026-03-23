import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

function loadJson(filename: string) {
    const p = path.join(DATA_DIR, filename);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ name: string }> }
) {
    const { name } = await params;
    const actressName = decodeURIComponent(name);
    // T-Powersなどスペース入り名前との照合用（正規化バリアント）
    const actressNameNoSpace = actressName.replace(/\s+/g, '');

    const fanzaProfiles: Record<string, any>  = loadJson('actress_profiles.json')    ?? {};
    const avwikiProfiles: Record<string, any> = loadJson('avwiki_profiles.json')     ?? {};
    const agencyProfiles: Record<string, any> = loadJson('agency_profiles.json')     ?? {};
    const aliasesData: string[][]             = loadJson('actress_aliases.json')     ?? [];
    const augmentedList: string[]             = loadJson('augmented_actresses.json') ?? [];

    // 名寄せ: 本名・旧名のどちらで来ても正規名を求める
    const aliasGroup = aliasesData.find(group => group.includes(actressName));
    const allNames = aliasGroup ?? [actressName];

    // FANZA プロフィール (いずれかの名前でヒット)
    let fanzaProfile: any = null;
    let canonicalName = actressName;
    for (const n of allNames) {
        if (fanzaProfiles[n] && !fanzaProfiles[n].not_found) {
            fanzaProfile = fanzaProfiles[n];
            canonicalName = n;
            break;
        }
    }

    // av-wiki プロフィール
    let avwikiProfile: any = null;
    for (const n of allNames) {
        if (avwikiProfiles[n] && !avwikiProfiles[n].not_found && !avwikiProfiles[n].error) {
            avwikiProfile = avwikiProfiles[n];
            break;
        }
    }

    // 事務所サイト プロフィール（優先度最高: 公式情報）
    // スペースあり/なし両方で照合（T-Powers: "五条 恋" vs FANZA: "五条恋"）
    let agencyProfile: any = null;
    const agencyKeys = Object.keys(agencyProfiles);
    for (const n of allNames) {
        const nNoSpace = n.replace(/\s+/g, '');
        const hit = agencyProfiles[n]
            ?? agencyProfiles[nNoSpace]
            ?? agencyKeys.find(k => k.replace(/\s+/g, '') === nNoSpace && agencyProfiles[k])
                ? agencyProfiles[agencyKeys.find(k => k.replace(/\s+/g, '') === nNoSpace)!]
                : undefined;
        if (hit) { agencyProfile = hit; break; }
    }
    // actressName自体がスペースなし版でもチェック
    if (!agencyProfile) {
        const hit = agencyKeys.find(k => k.replace(/\s+/g, '') === actressNameNoSpace);
        if (hit) agencyProfile = agencyProfiles[hit];
    }

    // 別名義: actress_aliases.json + avwiki の両方をマージ
    const aliasSet = new Set<string>();
    allNames.forEach(n => { if (n !== actressName) aliasSet.add(n); });
    if (avwikiProfile?.aliases) {
        avwikiProfile.aliases.forEach((a: string) => { if (a !== actressName) aliasSet.add(a); });
    }
    const aliases = [...aliasSet];

    // SNS優先度: 事務所公式 > av-wiki > なし
    const twitter   = agencyProfile?.twitter   ?? avwikiProfile?.twitter   ?? null;
    const instagram = agencyProfile?.instagram ?? avwikiProfile?.instagram ?? null;
    const tiktok    = agencyProfile?.tiktok    ?? avwikiProfile?.tiktok    ?? null;

    // 統合プロフィール
    const profile = {
        name: actressName,
        canonical_name: canonicalName,
        aliases,
        // サイズ: FANZAプロフィール優先、なければav-wikiから
        height:     fanzaProfile?.height  ?? avwikiProfile?.height  ?? null,
        bust:       fanzaProfile?.bust    ?? avwikiProfile?.bust    ?? null,
        waist:      fanzaProfile?.waist   ?? avwikiProfile?.waist   ?? null,
        hip:        fanzaProfile?.hip     ?? avwikiProfile?.hip     ?? null,
        cup:        fanzaProfile?.cup     ?? avwikiProfile?.cup     ?? null,
        birthday:   fanzaProfile?.birthday   ?? null,
        blood_type: fanzaProfile?.blood_type ?? null,
        hobby:       fanzaProfile?.hobby       ?? null,
        prefectures: fanzaProfile?.prefectures ?? null,
        image_url:   fanzaProfile?.image_url   ?? null,
        // SNS: 事務所公式優先
        twitter,
        instagram,
        tiktok,
        // ソース情報
        sns_source:  agencyProfile ? agencyProfile.source : (avwikiProfile ? 'avwiki' : null),
        agency_url:  agencyProfile?.url      ?? null,
        avwiki_url:  avwikiProfile?.url      ?? null,
        // 豊胸: allNamesのいずれかがaugmentedListに含まれるか
        augmented: allNames.some(n => augmentedList.includes(n)),
        // データソース
        has_fanza_profile:  !!fanzaProfile,
        has_avwiki_profile: !!avwikiProfile,
        has_agency_profile: !!agencyProfile,
    };

    return NextResponse.json(profile);
}
