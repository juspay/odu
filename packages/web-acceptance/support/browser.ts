const CONTAINER_ARGS: ReadonlyArray<string> = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

const HEADLESS_ARGS: ReadonlyArray<string> = ["--disable-gpu", "--headless=new"];

export const BROWSER_ARGS: ReadonlyArray<string> = [...CONTAINER_ARGS, ...HEADLESS_ARGS];
