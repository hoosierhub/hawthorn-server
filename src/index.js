const compression = require('compression')
const helmet = require('helmet')
const redis = require('redis')
const session = require('express-session')
const { dotenv } = require('dotenv')

const { GraphQLServer } = require('graphql-yoga')
const { prisma } = require('./generated/prisma-client')
const { resolvers } = require('./resolvers')
const { typeDefs } = require('./typeDefs')
const { AuthClient } = require('./services/auth')
const { EmailClient } = require('./services/email')
const { MockEmailClient } = require('./services/mockEmail')

let RedisStore = require('connect-redis')(session)
let redisClient = redis.createClient()

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const config = {
  cleanspeak: {
    apiKey: process.env.CLEANSPEAK_API_KEY,
    applicationId: process.env.APPLICATION_ID,
    baseUrl: process.env.CLEANSPEAK_BASE_URL
  },
  email: {
    apiKey: process.env.SENDGRID_API_KEY,
    groupInviteTemplateId: process.env.SENDGRID_GROUP_INVITE_TEMPLATE_ID
  },
  fusionAuth: {
    apiKey: process.env.FUSIONAUTH_API_KEY,
    clientId: process.env.FUSIONAUTH_CLIENT_ID,
    clientSecret: process.env.FUSIONAUTH_CLIENT_SECRET,
    endpoint: process.env.FUSIONAUTH_ENDPOINT,
    redirectUri: process.env.FUSIONAUTH_CLIENT_REDIRECT_URI,
    tenantId: process.env.FUSIONAUTH_TENANT_ID,
  },
  sessionSecret: process.env.SESSION_SECRET
}

const authClient = new AuthClient(config.fusionAuth)
const emailClient = config.email.apiKey ? new EmailClient(config.email) : new MockEmailClient()
const sessionSecret = process.env.SESSION_SECRET

const server = new GraphQLServer({
  typeDefs: typeDefs,
  resolvers,
  context: request => {
    return {
      ...request,
      prisma,
      authClient: authClient,
      emailClient: emailClient,
      config: config,
    }
  },
})
server.express.use(compression())
server.express.use(helmet())
server.express.use(
  session({
    name: "hawthorn.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
    },
    store: new RedisStore({ client: redisClient })
  })
)

// TODO - move to auth service?
server.express.use(async function(req, res, next) {
  const jwt = req.session.jwt
  if (jwt === null) {
    next()
  }
  let decodedJWT = await authClient.introspect(jwt)
  if (decodedJWT.error != null) {
    req.session.destroy()
    throw new Error(decodedJWT.error_description)
  }

  // Refresh the access token on the session if it has expired
  if (!decodedJWT.active && req.session.refreshToken) {
    const refreshedJwt = await authClient.refreshAccessToken(req.session.refreshToken)
    if (!refreshedJwt) {
      req.session.destroy()
      throw new AuthenticationError('Your session expired, please log back in')
    }

    req.session.jwt = refreshedJwt
    decodedJWT = await authClient.introspect(refreshedJwt)
    if (decodedJWT.error != null) {
      req.session.destroy()
      throw new Error(decodedJWT.error_description)
    }
  }

  req.decodedJWT = decodedJWT
  next()
})

const opts = {
  port: 4000,
  cors: {
    credentials: true,
    origin: true
  }
}

server.start(opts,
  () => console.log(`Server is running on http://localhost:${opts.port}`))
