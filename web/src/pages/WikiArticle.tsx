import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type WikiArticle as WikiArticleData } from '../lib/api';
import { Box } from '../components/Box';

export function WikiArticle() {
  const { id } = useParams();
  const [article, setArticle] = useState<WikiArticleData | null>(null);

  useEffect(() => {
    if (!id) return;
    setArticle(null);
    api.wikiArticle(id).then(setArticle);
  }, [id]);

  if (!article) return <p className="center">Loading&hellip;</p>;

  return (
    <Box title={article.title}>
      {/* article.body_html is generated offline by api/import/bbcode.mjs from
          escaped source text -- not user input at request time. */}
      <div className="wiki-body" dangerouslySetInnerHTML={{ __html: article.body_html }} />
    </Box>
  );
}
