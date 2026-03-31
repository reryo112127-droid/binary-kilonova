import { NextResponse } from 'next/server';
import { getContributorLeaderboard } from '../../../../lib/siteDb';

export const dynamic = 'force-dynamic';

export async function GET() {
    const leaderboard = await getContributorLeaderboard(20);
    return NextResponse.json(leaderboard);
}
