/** Static assets resolved by the apps' bundler (Vite) to a URL. */
declare module '*.svg' {
  const url: string;
  export default url;
}
