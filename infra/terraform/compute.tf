# =============================================================================
# EC2 Instance — Simple Setup (No ALB, direct access via public IP)
# =============================================================================

# --- Security Group ---
resource "aws_security_group" "app" {
  name        = "veradigm-app-sg"
  description = "Allow app ports + SSH"
  vpc_id      = data.aws_vpc.default.id

  # FHIR MCP
  ingress {
    description = "FHIR MCP"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Unity MCP
  ingress {
    description = "Unity MCP"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Admin Portal
  ingress {
    description = "Admin Portal"
    from_port   = 5001
    to_port     = 5001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP (for Let's Encrypt + redirect to HTTPS)
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SSH (optional)
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "veradigm-app-sg" }
}

# --- EC2 Instance ---
resource "aws_instance" "app" {
  ami                    = data.aws_ami.amazon_linux.id
  instance_type          = var.ec2_instance_type
  subnet_id              = tolist(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name

  user_data = templatefile("${path.module}/user-data.sh", {
    aws_region     = var.aws_region
    aws_account_id = data.aws_caller_identity.current.account_id
    project_name   = "veradigm"
  })

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }

  tags = { Name = "veradigm-app-server" }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

# --- Elastic IP (stable public IP) ---
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"
  tags     = { Name = "veradigm-eip" }
}
