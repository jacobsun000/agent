import { createConsola } from "consola";
const logger = createConsola({
  defaults: {
    tag: "Main"
  }
})

async function main() {
  logger.info("Starting the application...");
  throw Error("This is a test error to demonstrate error handling.");
}

main().catch((err) => {
  logger.error("An error occurred:", err);
  process.exit(1);
});

