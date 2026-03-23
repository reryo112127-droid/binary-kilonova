export type FanzaProduct = {
    product_id: string;
    title: string;
    actresses: string;
    main_image_url: string;
    affiliate_url: string;
    wish_count: number;
    genres: string;
    maker: string;
    sale_start_date: string;
    source: 'fanza';
};

export async function fetchFanzaProducts(params: {
    keyword?: string;
    actress?: string;
    maker?: string;
    label?: string;
    genre?: string;
    limit?: number;
    offset?: number;
    sort?: string;
}): Promise<FanzaProduct[]> {
    const apiId = process.env.DMM_API_ID;
    const affiliateId = process.env.DMM_AFFILIATE_ID;

    if (!apiId || !affiliateId) return [];

    const dmmSort = params.sort === 'new' ? 'date' : 'rank';
    const baseUrl = 'https://api.dmm.com/affiliate/v3/ItemList';
    
    // 検索条件の構築
    const searchParams = new URLSearchParams({
        api_id: apiId,
        affiliate_id: affiliateId,
        site: 'FANZA',
        service: 'digital',
        floor: 'videoa',
        hits: (params.limit || 20).toString(),
        offset: (params.offset || 1).toString(),
        sort: dmmSort,
        output: 'json'
    });

    if (params.keyword) searchParams.append('keyword', params.keyword);
    if (params.actress) searchParams.append('article', 'actress');
    if (params.actress) searchParams.append('article_id', ''); // IDベースでない場合はkeywordで代用するのが一般的
    if (params.maker) searchParams.append('article', 'maker');

    try {
        const response = await fetch(`${baseUrl}?${searchParams.toString()}`);
        if (!response.ok) return [];
        const data = await response.json();
        
        if (!data.result || !data.result.items) return [];

        return data.result.items.map((item: any) => ({
            product_id: item.content_id,
            title: item.title,
            actresses: item.iteminfo?.actress?.map((a: any) => a.name).join(', ') || '',
            main_image_url: item.imageURL?.large || item.imageURL?.list || '',
            affiliate_url: item.affiliateURL,
            wish_count: 0, // DMM APIからは直接取得できないため0とする
            genres: item.iteminfo?.genre?.map((g: any) => g.name).join(', ') || '',
            maker: item.iteminfo?.maker?.[0]?.name || '',
            sale_start_date: item.date,
            source: 'fanza'
        }));
    } catch (error) {
        console.error('FANZA API error:', error);
        return [];
    }
}
