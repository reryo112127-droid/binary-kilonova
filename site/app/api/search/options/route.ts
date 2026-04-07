import { NextRequest, NextResponse } from 'next/server';
import { getSearchOptions, getContextualSearchOptions } from '../../../../lib/searchOptions';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const actress = searchParams.get('actress') || '';
    const maker   = searchParams.get('maker')   || '';
    const label   = searchParams.get('label')   || '';
    const genre   = searchParams.get('genre')   || '';
    const q       = searchParams.get('q')       || '';
    const source  = searchParams.get('source')  || '';

    const hasFilter = !!(actress || maker || label || genre || q);
    const data = hasFilter
        ? await getContextualSearchOptions({ actress, maker, label, genre, q, source })
        : await getSearchOptions();

    return NextResponse.json(data);
}
