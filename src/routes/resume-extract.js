// routes/resume-extract.js - Static resume extraction for frontend development
export default async function resumeExtractRoutes(app) {
  app.post('/v1/resume/extract', async (req, reply) => {
    try {
      const body = await req.body;
      const { canonicalText } = body || {};

      // Validation
      if (!canonicalText?.trim()) {
        return reply.code(400).send({ 
          error: 'BAD_REQUEST', 
          message: 'Provide canonicalText field' 
        });
      }

      // For now, return static JSON data regardless of input
      // This allows frontend development without actual resume processing
      const staticResumeData = {
        resumeId: "rs_static_demo_123",
        extractionTimestamp: new Date().toISOString(),
        inputLength: canonicalText.length,
        
        // Basic Info
        basicInfo: {
          name: "John Smith",
          email: "john.smith@email.com",
          phone: "+1 (555) 123-4567",
          location: "San Francisco, CA",
          linkedin: "linkedin.com/in/johnsmith",
          website: "johnsmith.dev"
        },
        
        // Professional Summary
        summary: "Senior Software Engineer with 8+ years of experience in full-stack development, specializing in React, Node.js, and cloud technologies. Proven track record of leading teams and delivering scalable solutions.",
        
        // Work Experience
        workExperience: [
          {
            company: "TechCorp Inc.",
            position: "Senior Software Engineer",
            duration: "2021 - Present",
            location: "San Francisco, CA",
            achievements: [
              "Led development of microservices architecture serving 1M+ users",
              "Mentored 5 junior developers and improved team productivity by 30%",
              "Implemented CI/CD pipeline reducing deployment time by 60%"
            ],
            technologies: ["React", "Node.js", "AWS", "Docker", "Kubernetes"]
          },
          {
            company: "StartupXYZ",
            position: "Full Stack Developer",
            duration: "2019 - 2021",
            location: "Remote",
            achievements: [
              "Built MVP from scratch that secured $2M in funding",
              "Developed RESTful APIs handling 100K+ requests daily",
              "Optimized database queries improving response time by 40%"
            ],
            technologies: ["JavaScript", "Python", "PostgreSQL", "Redis", "Heroku"]
          }
        ],
        
        // Education
        education: [
          {
            degree: "Bachelor of Science in Computer Science",
            institution: "University of California, Berkeley",
            graduationYear: "2019",
            gpa: "3.8/4.0",
            relevantCourses: ["Data Structures", "Algorithms", "Software Engineering", "Database Systems"]
          }
        ],
        
        // Skills
        skills: {
          programmingLanguages: ["JavaScript", "Python", "Java", "TypeScript", "Go"],
          frontend: ["React", "Vue.js", "HTML5", "CSS3", "Sass"],
          backend: ["Node.js", "Express", "Django", "FastAPI", "GraphQL"],
          databases: ["PostgreSQL", "MongoDB", "Redis", "MySQL"],
          cloud: ["AWS", "Google Cloud", "Docker", "Kubernetes", "Terraform"],
          tools: ["Git", "Jenkins", "Jira", "Postman", "VS Code"]
        },
        
        // Certifications
        certifications: [
          {
            name: "AWS Certified Solutions Architect",
            issuer: "Amazon Web Services",
            date: "2023",
            expiry: "2026"
          },
          {
            name: "Certified Kubernetes Administrator",
            issuer: "Cloud Native Computing Foundation",
            date: "2022",
            expiry: "2025"
          }
        ],
        
        // Languages
        languages: [
          { language: "English", proficiency: "Native" },
          { language: "Spanish", proficiency: "Conversational" }
        ],
        
        // Projects
        projects: [
          {
            name: "E-commerce Platform",
            description: "Full-stack e-commerce solution with payment integration",
            technologies: ["React", "Node.js", "Stripe", "MongoDB"],
            github: "github.com/johnsmith/ecommerce",
            liveUrl: "ecommerce-demo.com"
          },
          {
            name: "Task Management App",
            description: "Real-time collaborative task management application",
            technologies: ["Vue.js", "Socket.io", "PostgreSQL", "Redis"],
            github: "github.com/johnsmith/taskapp"
          }
        ],
        
        // Meta Information
        metadata: {
          processingTime: "0.5ms",
          confidence: 0.95,
          extractionMethod: "static_demo_data",
          version: "1.0.0"
        }
      };

      return reply.send(staticResumeData);
      
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ 
        error: 'EXTRACTION_FAILED', 
        message: e.message 
      });
    }
  });
}
