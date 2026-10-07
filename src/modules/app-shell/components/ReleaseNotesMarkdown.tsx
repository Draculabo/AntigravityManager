import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isReleaseNotesLink } from '../update/releaseNotesLinks';

interface ReleaseNotesMarkdownProps {
  notes: string;
  onOpenLink: (url: string) => void;
}

export function ReleaseNotesMarkdown({ notes, onOpenLink }: ReleaseNotesMarkdownProps) {
  const components: Components = {
    a: ({ href, children }) => {
      if (!href || !isReleaseNotesLink(href)) {
        return (
          <span>
            {children}
            {href && <span className="text-muted-foreground break-all"> ({href})</span>}
          </span>
        );
      }
      return (
        <a
          href={href}
          className="text-primary underline underline-offset-4"
          onAuxClick={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            onOpenLink(href);
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ alt, src }) => (
      <span className="text-muted-foreground break-all">
        {alt}
        {src && ` (${src})`}
      </span>
    ),
  };

  // Images and unapproved URLs are text, so preserve their addresses without creating navigation.
  const preserveAddress = (url: string) => url;

  return (
    <div className="[&_code]:bg-muted [&_pre]:bg-muted space-y-3 text-sm leading-relaxed break-words [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:px-1 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-3 [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={components}
        skipHtml
        urlTransform={preserveAddress}
      >
        {notes}
      </Markdown>
    </div>
  );
}
