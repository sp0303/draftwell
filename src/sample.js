// Fictional example profile for people who want to try the app without a file.
module.exports = {
  name: 'Ananya Rao',
  title: 'Software Engineer I',
  contact: ['Hyderabad, India', 'ananya.rao@example.com', '+91 90000 00000', 'linkedin.com/in/ananya-rao', 'github.com/ananya-rao'],
  summary: 'Software Engineer I with around 2 years of experience building full-stack web applications using React, JavaScript, Node.js and Python. Experienced in responsive user interfaces, REST APIs and integrating LLM features into production products.',
  experience: [
    { role: 'Software Engineer I', org: 'Northwind Labs', dates: 'Jan 2025 – Present', bullets: [
      'Built React dashboards for internal analytics tools, cutting report preparation time by 35%.',
      'Developed a reusable React component library used across 4 product teams.',
      'Implemented FastAPI services and integrated LLM summarisation into the support workflow.',
      'Reduced page load time by 40% through code splitting and API response caching.',
    ] },
    { role: 'Associate Developer', org: 'Brightline Systems', dates: 'Jun 2023 – Dec 2024', bullets: [
      'Developed full-stack features with React and Spring Boot for a customer support portal.',
      'Wrote integration tests that raised API coverage from 52% to 81%.',
      'Worked in an Agile team of 8 with two-week releases.',
    ] },
  ],
  education: [{ school: 'Osmania University', degree: 'B.Tech, Computer Science', dates: '2019 – 2023', detail: 'CGPA 8.4 / 10' }],
  skills: [
    { group: 'Frontend', items: ['React', 'JavaScript', 'TypeScript', 'HTML5', 'CSS3'] },
    { group: 'Backend', items: ['Node.js', 'FastAPI', 'Spring Boot', 'REST APIs'] },
    { group: 'Data & Tools', items: ['PostgreSQL', 'MongoDB', 'Docker', 'Git', 'AWS'] },
  ],
  projects: [
    { name: 'Expense Splitter', tech: 'React, Node.js, MongoDB', year: '2024', bullets: ['Shared-expense web app with real-time balances, used by 300+ students.'] },
    { name: 'Interview Prep Bot', tech: 'Python, FastAPI, OpenAI API', year: '2025', bullets: ['Chat assistant that generates mock interview questions from a job description.'] },
  ],
  certifications: ['AWS Certified Cloud Practitioner (2024)'],
};
