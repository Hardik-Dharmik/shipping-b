# Deploying to Vercel

This guide will help you deploy your Express.js backend to Vercel.

## Prerequisites

1. A Vercel account (sign up at [vercel.com](https://vercel.com))
2. Vercel CLI installed (optional, for CLI deployment)
3. All environment variables ready

## Deployment Steps

### Method 1: Deploy via Vercel Dashboard (Recommended)

1. **Push your code to GitHub/GitLab/Bitbucket**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin <your-repo-url>
   git push -u origin main
   ```

2. **Import Project to Vercel**
   - Go to [vercel.com/dashboard](https://vercel.com/dashboard)
   - Click "Add New Project"
   - Import your Git repository
   - Vercel will auto-detect it as a Node.js project

3. **Configure Environment Variables**
   In the Vercel project settings, add these environment variables:
   ```
   SUPABASE_URL=your_supabase_project_url
   SUPABASE_API_KEY=your_supabase_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   JWT_SECRET=your_jwt_secret
   JWT_EXPIRES_IN=7d
   ADMIN_TOKEN=your_admin_token
   ADMIN_EMAILS=admin@example.com
   PORT=3000
   NODE_ENV=production
   ```

4. **Deploy**
   - Click "Deploy"
   - Wait for the build to complete
   - Your API will be live at `https://your-project.vercel.app`

### Method 2: Deploy via Vercel CLI

1. **Install Vercel CLI**
   ```bash
   npm i -g vercel
   ```

2. **Login to Vercel**
   ```bash
   vercel login
   ```

3. **Deploy**
   ```bash
   vercel
   ```

4. **Set Environment Variables**
   ```bash
   vercel env add SUPABASE_URL
   vercel env add SUPABASE_API_KEY
   vercel env add SUPABASE_SERVICE_ROLE_KEY
   vercel env add JWT_SECRET
   vercel env add JWT_EXPIRES_IN
   vercel env add ADMIN_TOKEN
   vercel env add ADMIN_EMAILS
   ```

5. **Deploy to Production**
   ```bash
   vercel --prod
   ```

## Important Notes for Vercel

### 1. File Uploads
- The `uploads/` directory is ephemeral (temporary) on Vercel
- Files are automatically cleaned up after each function execution
- This is fine because we upload files to Supabase Storage immediately
- The local file cleanup happens automatically

### 2. Serverless Functions
- Vercel runs your Express app as serverless functions
- Each API route becomes a separate function
- Cold starts may occur (first request might be slower)

### 3. Function Timeout
- Vercel has execution time limits:
  - Hobby: 10 seconds
  - Pro: 60 seconds
  - Enterprise: 300 seconds
- File uploads should complete within this time

### 4. Environment Variables
- Never commit `.env` files
- Set all variables in Vercel dashboard
- Variables are encrypted and secure

### 5. API Routes
Your API will be available at:
- `https://your-project.vercel.app/api/register`
- `https://your-project.vercel.app/api/auth/login`
- `https://your-project.vercel.app/api/admin/pending`
- etc.

## Testing Deployment

After deployment, test your endpoints:

```bash
# Test registration
curl -X POST https://your-project.vercel.app/api/register \
  -F "name=Test User" \
  -F "email=test@example.com" \
  -F "password=password123" \
  -F "company_name=Test Corp" \
  -F "file=@test.pdf"

# Test login
curl -X POST https://your-project.vercel.app/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}'
```

## Troubleshooting

### Issue: "Function timeout"
- **Solution**: Optimize file uploads or upgrade Vercel plan
- Check file size limits (10MB should be fine)

### Issue: "Module not found"
- **Solution**: Ensure all dependencies are in `package.json`
- Run `npm install` locally to verify

### Issue: "Environment variable not found"
- **Solution**: Double-check all env vars are set in Vercel dashboard
- Redeploy after adding new variables

### Issue: "File upload fails"
- **Solution**: Check Supabase Storage bucket permissions
- Verify `SUPABASE_SERVICE_ROLE_KEY` is set correctly

### Issue: "Database connection error"
- **Solution**: Verify Supabase credentials
- Check if Supabase project is active

## Monitoring

- View logs in Vercel dashboard under "Functions" tab
- Check function execution times
- Monitor error rates

## Continuous Deployment

- Vercel automatically deploys on every push to main branch
- Preview deployments for pull requests
- Configure in Vercel dashboard → Settings → Git

## Production Checklist

- [ ] All environment variables set
- [ ] Database schema deployed
- [ ] Storage bucket created and policies set
- [ ] Admin user created
- [ ] CORS configured (if needed for frontend)
- [ ] API endpoints tested
- [ ] Error handling verified
- [ ] Logging working

## Additional Configuration

### Custom Domain
1. Go to Vercel project settings
2. Add your custom domain
3. Update DNS records as instructed

### CORS for Frontend
If your frontend is on a different domain, update CORS in `index.js`:
```javascript
app.use(cors({
  origin: ['https://your-frontend.vercel.app', 'https://yourdomain.com'],
  credentials: true
}));
```

## Support

- Vercel Docs: [vercel.com/docs](https://vercel.com/docs)
- Vercel Community: [github.com/vercel/vercel/discussions](https://github.com/vercel/vercel/discussions)

