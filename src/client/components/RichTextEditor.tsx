/**
 * The WYSIWYG editor for news posts (TipTap).
 *
 * Emits sanitized HTML on every change (see richtext.ts) so the value the
 * parent holds — and later saves — is already clean; it's sanitized again on
 * render. Uncontrolled after mount: remount it with a `key` to load different
 * content (e.g. when switching which post is being edited).
 */

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { MorphIcon } from 'morphicons/react';
import { Link as LinkIcon, Quote, type IconNode } from 'lucide';
import { sanitizeHtml } from '../lib/richtext';

function ToolButton({
  editor,
  onClick,
  active,
  disabled,
  label,
  icon,
  title,
}: {
  editor: Editor;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label?: string;
  icon?: IconNode;
  title: string;
}) {
  return (
    <button
      type="button"
      className={active ? 'rte-tool active' : 'rte-tool'}
      title={title}
      // Keep focus in the document so the command applies to the selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onClick();
        editor.commands.focus();
      }}
      disabled={disabled}
    >
      {icon ? <MorphIcon icon={icon} size={14} aria-hidden /> : label}
    </button>
  );
}

export default function RichTextEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor }) => onChange(sanitizeHtml(editor.getHTML())),
  });

  if (!editor) return null;

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link URL (leave blank to remove):', prev ?? 'https://');
    if (url === null) return; // cancelled
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };

  return (
    <div className="rte">
      <div className="rte-toolbar">
        <ToolButton editor={editor} label="B" title="Bold" active={editor.isActive('bold')} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolButton editor={editor} label="I" title="Italic" active={editor.isActive('italic')} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolButton editor={editor} label="S" title="Strikethrough" active={editor.isActive('strike')} disabled={disabled} onClick={() => editor.chain().focus().toggleStrike().run()} />
        <span className="rte-sep" />
        <ToolButton editor={editor} label="H1" title="Heading 1" active={editor.isActive('heading', { level: 1 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
        <ToolButton editor={editor} label="H2" title="Heading 2" active={editor.isActive('heading', { level: 2 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <ToolButton editor={editor} label="H3" title="Heading 3" active={editor.isActive('heading', { level: 3 })} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
        <span className="rte-sep" />
        <ToolButton editor={editor} label="• List" title="Bullet list" active={editor.isActive('bulletList')} disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolButton editor={editor} label="1. List" title="Numbered list" active={editor.isActive('orderedList')} disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <ToolButton editor={editor} icon={Quote} title="Quote" active={editor.isActive('blockquote')} disabled={disabled} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
        <ToolButton editor={editor} label="{ }" title="Code block" active={editor.isActive('codeBlock')} disabled={disabled} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        <span className="rte-sep" />
        <ToolButton editor={editor} icon={LinkIcon} title="Link" active={editor.isActive('link')} disabled={disabled} onClick={setLink} />
      </div>
      <EditorContent editor={editor} className="rte-content" />
    </div>
  );
}
