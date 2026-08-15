import { getChannel, getHfmpegVersion, getProducerVersion, PINNED_CHROMIUM_VERSION } from "../meta.js";
import { EXIT_CODES } from "../output/errors.js";
import { printJsonEnvelope } from "../output/json.js";

export function runVersionCommand(json: boolean): number {
  const hfmpegVersion = getHfmpegVersion();
  const producerVersion = getProducerVersion();

  const data = {
    hfmpeg: hfmpegVersion,
    channel: getChannel(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    upstream: producerVersion ? { "@hyperframes/producer": producerVersion } : {},
    chromiumPinned: PINNED_CHROMIUM_VERSION,
  };

  if (json) {
    printJsonEnvelope({ ok: true, command: "version", data });
  } else {
    console.log(`hfmpeg ${hfmpegVersion} (${data.channel})`);
    console.log(`node ${data.node} - ${data.platform}`);
    console.log(
      producerVersion
        ? `@hyperframes/producer ${producerVersion}`
        : "@hyperframes/producer not resolvable (run npm install)",
    );
    console.log(`chromium (pinned) ${PINNED_CHROMIUM_VERSION}`);
  }

  return EXIT_CODES.OK;
}
