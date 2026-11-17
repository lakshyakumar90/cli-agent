import type {MDXComponents} from 'mdx/types';
import Link from 'next/link';
import {CodeBlock} from '@/components/code-block';
import {Diagram} from '@/components/diagram';
import {FileReference} from '@/components/file-reference';
export function useMDXComponents(components:MDXComponents):MDXComponents{return {pre:CodeBlock as MDXComponents['pre'],a:({href,children,...props})=>href?.startsWith('/')?<Link href={href} {...props}>{children}</Link>:<a href={href} {...props}>{children}</a>,table:props=><div className="table-scroll"><table {...props}/></div>,Callout:({children,title='Good to know'}:{children:React.ReactNode;title?:string})=><aside className="callout"><strong>{title}</strong><div>{children}</div></aside>,Diagram,FileReference,...components};}
