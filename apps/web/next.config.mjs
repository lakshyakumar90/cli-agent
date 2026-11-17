import createMDX from "@next/mdx";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";

const withMDX = createMDX({
  options: { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeSlug] },
});
export default withMDX({
  pageExtensions: ["js", "jsx", "mdx", "ts", "tsx"],
  poweredByHeader: false,
});
