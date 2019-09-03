const Twit = require('twit');

import { config } from './config';
import { fetchFeed, createResponse } from './hsl';

const PREVIOUSLY_BROKEN_KEY = 'previously-broken';
const PREVIOUS_TWEET_TIME_KEY = 'previous-tweet-time';
const brokenStatusCacheTtlSeconds =
  process.env.STATUS_CACHE_TTL_SECONDS || 60 * 60 * 24;

let redisClient, bot, cacheKey, cacheTtl;

export const setupTwitterBot = (
  redisInstance,
  cacheKeyParam,
  cacheTtlSecondsParam
) => {
  redisClient = redisInstance;
  bot = new Twit(config.twitterKeys);
  cacheKey = cacheKeyParam;
  cacheTtl = cacheTtlSecondsParam;
  console.log('Bot starting...');
  tweetIfBroken();
  setInterval(tweetIfBroken, config.twitterConfig.check);
};

const tweetNow = async (text, brokenNow) => {
  const tweet = {
    status: text
  };

  if (config.twitterConfig.enabled) {
    console.log('Tweeting enabled – going to try to tweet: ', text);
    bot.post('statuses/update', tweet, (err, data, response) => {
      if (err) {
        console.error('ERROR in tweeting!', err);
      } else {
        console.log('SUCCESS! tweeted: ', text);
        savePreviousTweetTime(new Date());
        saveBrokenStatus(brokenNow);
      }
    });
  } else {
    console.log('Tweeting was disabled, but would have tweeted:', {
      text,
      brokenNow
    });
    savePreviousTweetTime(new Date());
    saveBrokenStatus(brokenNow);
  }
};

const saveBrokenStatus = async brokenNow => {
  if (redisClient) {
    return redisClient.setex(
      PREVIOUSLY_BROKEN_KEY,
      brokenStatusCacheTtlSeconds,
      brokenNow
    );
  } else {
    console.warn('Redis unavailable, unable to saveBrokenStatus!');
  }
};

const getPreviousBrokenStatus = async (): Promise<boolean> =>
  new Promise((resolve, reject) => {
    if (redisClient) {
      redisClient.get(PREVIOUSLY_BROKEN_KEY, (error, result) => {
        console.log(getPreviousBrokenStatus, { result, error });
        if (error) {
          resolve(false);
        }
        resolve(result === 'true');
      });
    } else {
      console.warn('Redis unavailable, unable getPreviousBrokenStatus!');
      resolve(false);
    }
  });

const savePreviousTweetTime = async previousTweetTime => {
  if (redisClient) {
    return redisClient.setex(
      PREVIOUS_TWEET_TIME_KEY,
      brokenStatusCacheTtlSeconds,
      previousTweetTime.toString()
    );
  } else {
    console.warn('Redis unavailable, unable savePreviousTweetTime!');
  }
};

const getPreviousTweetTime = async (): Promise<Date | null> =>
  new Promise((resolve, reject) => {
    if (redisClient) {
      redisClient.get(PREVIOUS_TWEET_TIME_KEY, (error, result) => {
        if (error) {
          resolve(null);
        }

        if (result !== null) {
          resolve(new Date(result));
        }
        resolve(null);
      });
    } else {
      console.warn('Redis unavailable, unable getPreviousTweetTime!');
      resolve(null);
    }
  });

const shouldTweetNow = async brokenNow =>
  new Promise(async (resolve, reject) => {
    const previouslyWasBroken = await getPreviousBrokenStatus();
    const previousTweetTime: Date | null = await getPreviousTweetTime();
    console.log({ previouslyWasBroken, previousTweetTime });

    if (brokenNow === true && previouslyWasBroken === false) {
      resolve(true);
    } else if (
      previouslyWasBroken === true &&
      brokenNow === false &&
      previousTweetTime !== null &&
      new Date().getTime() - previousTweetTime.getTime() >
        config.twitterConfig.minInterval
    ) {
      resolve(true);
    } else {
      resolve(false);
    }
  });

const tweetIfBroken = async () => {
  console.log('Checking if broken and tweeting maybe');
  await fetchFeed()
    .then(async feed => {
      const dataToRespondWith = createResponse(feed);

      if (redisClient) {
        // Update redis cache with the response
        redisClient.setex(
          cacheKey,
          cacheTtl,
          JSON.stringify(dataToRespondWith),
          () => console.log('Bot successfully updated cache')
        );
      }

      const brokenNow = dataToRespondWith.broken;
      const shouldTweet = await shouldTweetNow(brokenNow);

      console.log('tweetIfBroken', { shouldTweet, brokenNow });
      if (shouldTweet) {
        console.log('Decided to tweet at', new Date());
        if (brokenNow) {
          const tweetText = `JUURI NYT – Metrossa häiriö:
${(dataToRespondWith.reasons[0][0] as any).text.substring(0, 170)}
Katso: https://onkometrorikki.fi #länsimetro #hsl #metrohelsinki`;
          tweetNow(tweetText, brokenNow);
        } else {
          const timeNowStr = new Date().toLocaleTimeString();
          const tweetText = `JUURI NYT – Metro toimii jälleen! Katso: https://onkometrorikki.fi Kello on nyt ${timeNowStr}. #länsimetro #hsl #metrohelsinki`;
          tweetNow(tweetText, brokenNow);
        }
      } else {
        console.log('Decided not to tweet this time');
      }
    })
    .catch(e => {
      console.log('Error in fetching data');
      console.error(e);
    });
};
