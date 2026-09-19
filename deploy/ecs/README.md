# ECS deployment (ECR + ECS on the existing EC2 host, no load balancer)

Push to `aws` → GitHub Actions runs the checks, builds the image, pushes it to ECR and rolls
it out to ECS. The app stays at the instance's Elastic IP (`http://13.202.56.144`).

| Piece | Name |
|---|---|
| Region / account | `ap-south-1` / `774697186948` |
| ECR repository | `deep-agents-app` (keeps the last 5 images) |
| ECS cluster / service | `deep-agents-cluster` / `deep-agents-service` |
| Task definition family | `deep-agents-task` ([task-definition.json](task-definition.json)) |
| Container host | EC2 `deep-agents-app` (`i-0ed7a15e29db1b8bc`) |
| Secrets | SSM Parameter Store, `/deep-agents/*` (SecureString) |
| Sign-in | GitHub OAuth App; allowed users in `ALLOWED_GITHUB_USERS` |
| Logs | CloudWatch `/ecs/deep-agents-app` (7-day retention) |
| GitHub → AWS | OIDC role `deepAgentsGithubDeployRole`, repo secret `AWS_DEPLOY_ROLE_ARN` |

**Why no ALB:** one task on one host doesn't need load balancing, and an ALB is the largest
fixed cost of a small ECS setup. The trade-off is ~1 minute of downtime per deploy, because
the old task must release host port 80 before the new one starts (`minimumHealthyPercent=0`).

## One-time setup

Run steps 1–5 in **AWS CloudShell** (console top bar, `>_` icon) with the region set to
**Asia Pacific (Mumbai)**. None of these steps affect the running app.

### 1. ECR, log group, cluster

```bash
aws ecr create-repository --repository-name deep-agents-app --image-scanning-configuration scanOnPush=true
aws ecr put-lifecycle-policy --repository-name deep-agents-app --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep last 5","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}'
aws logs create-log-group --log-group-name /ecs/deep-agents-app
aws logs put-retention-policy --log-group-name /ecs/deep-agents-app --retention-in-days 7
aws ecs create-cluster --cluster-name deep-agents-cluster
```

### 2. Secrets

The app signs users in with GitHub, so first create a **GitHub OAuth App** at
<https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**:

| Field | Value |
|---|---|
| Homepage URL | `http://13.202.56.144` (must match `PUBLIC_URL` in the task definition) |
| Authorization callback URL | `http://13.202.56.144/auth/github/callback` |

Then generate a client secret on the app's page. Prompts below hide input, so nothing lands in
shell history or on screen. `APP_SECRET` is any random 64-character hex string, e.g. from
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

```bash
for name in GITHUB_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_SECRET APP_SECRET E2B_API_KEY MONGODB_URI; do
  read -rsp "$name: " value; echo
  aws ssm put-parameter --name "/deep-agents/$name" --type SecureString --value "$value" --overwrite > /dev/null && echo "  saved"
done
unset value
```

Every parameter listed in the task definition must exist, or the task fails to start (and the
deploy rolls back). Model API keys are **not** stored here: each user saves their own in
**My keys**, and the server's keys are never used for them.

#### Optional: LangSmith tracing

Enabled in this deployment: `task-definition.json` reads `/deep-agents/LANGSMITH_API_KEY`, so that
parameter must exist or the task fails to start. For a fresh setup, create it before the first
deploy (step 1), or remove the three `LANGSMITH_*` entries to run without tracing. What gets sent
is described under **Tracing** in the main README: traces contain your users' source code, with
credentials masked.

1. Save the key (a LangSmith API key from smith.langchain.com → Settings):

   ```bash
   read -rsp "LANGSMITH_API_KEY: " value; echo
   aws ssm put-parameter --name "/deep-agents/LANGSMITH_API_KEY" --type SecureString --value "$value" --overwrite > /dev/null && echo "  saved"
   unset value
   ```

2. Then add to `task-definition.json` and push — under `environment`:

   ```json
   { "name": "LANGSMITH_TRACING", "value": "true" },
   { "name": "LANGSMITH_PROJECT", "value": "code-migration-agents" }
   ```

   and under `secrets`:

   ```json
   { "name": "LANGSMITH_API_KEY", "valueFrom": "arn:aws:ssm:ap-south-1:774697186948:parameter/deep-agents/LANGSMITH_API_KEY" }
   ```

   Add `LANGSMITH_HIDE_INPUTS` / `LANGSMITH_HIDE_OUTPUTS` set to `"true"` to send no code at all.
   The first log line after `Server listening` says whether tracing is on and what it sends.

Who may sign in is `ALLOWED_GITHUB_USERS` in `task-definition.json` (comma-separated GitHub
usernames) — edit and push to add someone. Rotating `APP_SECRET` signs everyone out and makes
saved keys unreadable, so users would have to save them again.

### 3. IAM roles

```bash
ACCOUNT=774697186948
REPO=naveensnsgroups/Deep_Agents_framwork

# 3a. Task execution role — lets ECS pull from ECR, write logs and read /deep-agents/* secrets.
aws iam create-role --role-name deepAgentsEcsTaskExecutionRole --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name deepAgentsEcsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name deepAgentsEcsTaskExecutionRole --policy-name read-deep-agents-secrets --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"ssm:GetParameters\",\"Resource\":\"arn:aws:ssm:ap-south-1:$ACCOUNT:parameter/deep-agents/*\"}]}"

# 3b. Instance role — lets the EC2 host register with the ECS cluster.
aws iam create-role --role-name deepAgentsEcsInstanceRole --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name deepAgentsEcsInstanceRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role
aws iam create-instance-profile --instance-profile-name deepAgentsEcsInstanceProfile
aws iam add-role-to-instance-profile --instance-profile-name deepAgentsEcsInstanceProfile --role-name deepAgentsEcsInstanceRole

# 3c. GitHub OIDC provider + deploy role, trusted only for pushes to the aws branch of this repo.
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
aws iam create-role --role-name deepAgentsGithubDeployRole --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\"arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com\"},\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":\"repo:naveensnsgroups@186386913/Deep_Agents_framwork@1363485819:ref:refs/heads/aws\"}}}]}"
aws iam put-role-policy --role-name deepAgentsGithubDeployRole --policy-name deploy-deep-agents --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchCheckLayerAvailability\",\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\",\"ecr:InitiateLayerUpload\",\"ecr:UploadLayerPart\",\"ecr:CompleteLayerUpload\",\"ecr:PutImage\"],\"Resource\":\"arn:aws:ecr:ap-south-1:$ACCOUNT:repository/deep-agents-app\"},
  {\"Effect\":\"Allow\",\"Action\":[\"ecs:RegisterTaskDefinition\",\"ecs:DescribeTaskDefinition\"],\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":[\"ecs:UpdateService\",\"ecs:DescribeServices\"],\"Resource\":\"arn:aws:ecs:ap-south-1:$ACCOUNT:service/deep-agents-cluster/deep-agents-service\"},
  {\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":\"arn:aws:iam::$ACCOUNT:role/deepAgentsEcsTaskExecutionRole\"}
]}"
echo "AWS_DEPLOY_ROLE_ARN = arn:aws:iam::$ACCOUNT:role/deepAgentsGithubDeployRole"
```

If `create-open-id-connect-provider` says it already exists, that's fine — continue.

The trust policy's `sub` uses GitHub's immutable-ID format (`owner@ownerId/repo@repoId`), which is
what this repo's OIDC tokens carry. The console's "Web identity → GitHub" wizard writes the older
`repo:owner/repo:...` form, which never matches — AWS then rejects the login with
`Not authorized to perform sts:AssumeRoleWithWebIdentity`.

### 4. Attach the instance role to the EC2 host

```bash
aws ec2 describe-iam-instance-profile-associations --filters Name=instance-id,Values=i-0ed7a15e29db1b8bc --query 'IamInstanceProfileAssociations[].IamInstanceProfile.Arn'
```

- Prints `[]` → attach it:
  `aws ec2 associate-iam-instance-profile --instance-id i-0ed7a15e29db1b8bc --iam-instance-profile Name=deepAgentsEcsInstanceProfile`
- Prints an existing profile → stop and check what it's used for before replacing it.

### 5. Create the service (with 0 tasks)

The service is created before any real image exists, using a tiny placeholder revision at
desired count 0 — nothing runs yet. The first workflow run registers the real revision and
sets the count to 1.

```bash
aws ecs register-task-definition --family deep-agents-task --requires-compatibilities EC2 --network-mode bridge \
  --container-definitions '[{"name":"app","image":"public.ecr.aws/docker/library/busybox:latest","memory":32,"essential":true}]' > /dev/null
aws ecs create-service --cluster deep-agents-cluster --service-name deep-agents-service \
  --task-definition deep-agents-task --desired-count 0 --launch-type EC2 \
  --deployment-configuration "minimumHealthyPercent=0,maximumPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}" > /dev/null && echo "service created"
```

### 6. GitHub secret

Repo → **Settings → Secrets and variables → Actions → New repository secret**:
name `AWS_DEPLOY_ROLE_ARN`, value printed at the end of step 3.

### 7. Switch the EC2 host from Docker Compose to ECS

**The app is offline from here until the first deploy finishes (~5–10 min).** SSH in:

```bash
cd ~/app && docker compose down          # NOT "down -v"
sudo dnf install -y ecs-init
echo "ECS_CLUSTER=deep-agents-cluster" | sudo tee /etc/ecs/ecs.config
sudo systemctl enable --now docker ecs
```

Check it joined (in CloudShell) — should print one ARN:

```bash
aws ecs list-container-instances --cluster deep-agents-cluster
```

### 8. First deploy

Commit and push to `aws`, then watch **GitHub → Actions → Deploy to ECS**. When it's green,
open `http://13.202.56.144`.

## Everyday use

- **Deploy:** push to `aws`. Or GitHub → Actions → Deploy to ECS → **Run workflow**.
- **Logs:** CloudShell `aws logs tail /ecs/deep-agents-app --follow`
- **Stop the app (keep the server):** `aws ecs update-service --cluster deep-agents-cluster --service deep-agents-service --desired-count 0` — the next deploy starts it again.
- **Stop the server (save money):** EC2 → Stop instance. On Start, the ECS agent comes back up and ECS restarts the task by itself; the Elastic IP stays the same.
- **Change a secret:** re-run step 2 for that name, then force a new task:
  `aws ecs update-service --cluster deep-agents-cluster --service deep-agents-service --force-new-deployment`
- **Change a non-secret setting** (`ALLOWED_GITHUB_USERS`, `ALLOWED_ORIGINS`, model names): edit `task-definition.json` and push.
- **Sandboxes across deploys:** a deploy detaches running E2B sandboxes instead of killing them, so users reconnect to the same one (edits intact) after the ~1 minute restart. One nobody returns to within 10 minutes is reclaimed by E2B.
- **Failed deploy:** the circuit breaker rolls back to the previous revision automatically; the logs command above shows why the new one failed.
