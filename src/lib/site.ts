export const SITE = {
  name: "Verdu",
  lang: "es",
  description:
    "Portfolio personal y profesional de Verdu, con un asistente de IA que responde sobre su trabajo.",
  url: "https://verdu.dev",
  nav: [
    { label: "Inicio", href: "/" },
    { label: "Sobre mí", href: "/sobre-mi" },
    { label: "Habilidades", href: "/habilidades" },
    { label: "Servicios", href: "/servicios" },
    { label: "Experiencia", href: "/experiencia" },
    { label: "Proyectos", href: "/proyectos" },
    { label: "Contacto", href: "/contacto" },
  ],
} as const;

export type Site = typeof SITE;
export type NavItem = (typeof SITE.nav)[number];
