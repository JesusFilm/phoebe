// The Coss UI components read their colours off a `.dark` class on <html>
// (index.css, `@custom-variant dark`). The console has no theme switch: light
// and dark follow the OS (#526), which console.css does with a media query. This
// puts the class where the components look, from the same media query, and
// keeps it there as the OS changes.

export function followSystemTheme(root: HTMLElement = document.documentElement): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    root.classList.toggle("dark", query.matches);
  };
  apply();
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}
