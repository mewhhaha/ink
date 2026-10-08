import { useSession, useSessionValue } from "./context.tsx";

export function useMessages<K extends string = string>() {
  const session = useSession();
  // Subscribing to the schema too refreshes translated text after a hot reload.
  useSessionValue((s) => s.schema);
  const locale = useSessionValue((s) => s.locale);
  return {
    locale,
    locales: [
      ...new Set([
        session.schema.defaultLocale,
        ...Object.keys(session.schema.locales),
      ]),
    ],
    setLocale: (value: string) => session.setLocale(value),
    text: (name: K | number, ...args: (number | string)[]) =>
      session.message(name, ...args),
  };
}

/** Optional language control for a game's HUD or editor. */
export function LanguageSelect() {
  const { locale, locales, setLocale } = useMessages();
  if (locales.length < 2) return null;
  return (
    <select
      aria-label="Language"
      value={locale}
      onChange={(e) => setLocale(e.target.value)}
    >
      {locales.map((value) => (
        <option key={value} value={value}>{value.toUpperCase()}</option>
      ))}
    </select>
  );
}
